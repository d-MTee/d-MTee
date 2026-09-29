//! KMS-encrypted, participant-scoped FROST key-package persistence.
//!
//! Only KMS ciphertext is written to disk. The active epoch is selected by a
//! single atomically replaced manifest; startup never guesses the newest key.

use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

const MAX_KMS_PLAINTEXT: usize = 4096;

#[derive(Clone, Debug)]
pub struct KmsEncryptedKeyStore {
    participant_id: String,
    directory: PathBuf,
    kms_key_id: String,
    helper: PathBuf,
    python: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct EncryptedEpoch {
    format_version: u8,
    participant_id: String,
    key_id: String,
    threshold: u16,
    total_participants: u16,
    transcript_hash: String,
    private_package_hash: String,
    public_package_hash: String,
    encrypted_private_package: String,
    encrypted_public_package: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ActiveEpoch {
    format_version: u8,
    participant_id: String,
    key_id: String,
    threshold: u16,
    total_participants: u16,
    transcript_hash: String,
    public_package_hash: String,
}

#[derive(Serialize)]
struct KmsRequest<'a> {
    operation: &'a str,
    payload: String,
    encryption_context: KmsContext<'a>,
}

#[derive(Clone, Serialize)]
struct KmsContext<'a> {
    application: &'static str,
    participant_id: &'a str,
    key_id: &'a str,
    transcript_hash: &'a str,
    threshold: String,
    total_participants: String,
    package_type: &'a str,
}

#[derive(Deserialize)]
struct KmsResponse {
    ok: bool,
    result: Option<String>,
    error: Option<String>,
}

pub struct RestoredEpoch {
    pub key_id: String,
    pub threshold: u16,
    pub total_participants: u16,
    pub transcript_hash: String,
    pub private_package: Vec<u8>,
    pub public_package: Vec<u8>,
}

impl KmsEncryptedKeyStore {
    pub fn from_env(participant_id: &str) -> Result<Self, Box<dyn std::error::Error>> {
        validate_id(participant_id)?;
        let directory = PathBuf::from(std::env::var("MPC_KEY_STORE_DIR")?);
        let kms_key_id = std::env::var("FROST_KMS_KEY_ID")?;
        if kms_key_id.is_empty() {
            return Err("FROST_KMS_KEY_ID_REQUIRED".into());
        }
        let helper = std::env::var_os("FROST_KMS_HELPER")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("mpc/frost-signer/scripts/kms_share_store.py"));
        if !helper.is_file() {
            return Err("FROST_KMS_HELPER_NOT_FOUND".into());
        }
        Ok(Self {
            participant_id: participant_id.to_string(),
            kms_key_id,
            directory,
            helper,
            python: std::env::var("PYTHON_BIN").unwrap_or_else(|_| "python3".to_string()),
        })
    }

    pub fn save_pending(
        &self,
        key_id: &str,
        threshold: u16,
        total_participants: u16,
        transcript_hash: &str,
        mut private_package: Vec<u8>,
        public_package: &[u8],
    ) -> Result<(), Box<dyn std::error::Error>> {
        validate_id(key_id)?;
        validate_sha256(transcript_hash)?;
        if threshold < 2 || threshold > total_participants || total_participants > 16 {
            private_package.zeroize();
            return Err("INVALID_KEY_EPOCH_PARAMETERS".into());
        }
        if private_package.is_empty()
            || private_package.len() > MAX_KMS_PLAINTEXT
            || public_package.is_empty()
            || public_package.len() > MAX_KMS_PLAINTEXT
        {
            private_package.zeroize();
            return Err("FROST_PACKAGE_EXCEEDS_KMS_PLAINTEXT_LIMIT".into());
        }
        let private_hash = sha256(&private_package);
        let public_hash = sha256(public_package);
        let private_context = self.context(
            key_id,
            transcript_hash,
            threshold,
            total_participants,
            "private",
        );
        let public_context = self.context(
            key_id,
            transcript_hash,
            threshold,
            total_participants,
            "public",
        );
        let encrypted_private = match self.encrypt(&private_package, &private_context) {
            Ok(value) => value,
            Err(error) => {
                private_package.zeroize();
                return Err(error);
            }
        };
        private_package.zeroize();
        let encrypted_public = self.encrypt(public_package, &public_context)?;
        let epoch = EncryptedEpoch {
            format_version: 1,
            participant_id: self.participant_id.clone(),
            key_id: key_id.to_string(),
            threshold,
            total_participants,
            transcript_hash: transcript_hash.to_string(),
            private_package_hash: private_hash,
            public_package_hash: public_hash,
            encrypted_private_package: BASE64.encode(encrypted_private),
            encrypted_public_package: BASE64.encode(encrypted_public),
        };
        let destination = self.epoch_path(key_id);
        if destination.exists() {
            let existing: EncryptedEpoch = serde_json::from_slice(&fs::read(&destination)?)?;
            if existing.participant_id != self.participant_id
                || existing.key_id != epoch.key_id
                || existing.threshold != epoch.threshold
                || existing.total_participants != epoch.total_participants
                || existing.transcript_hash != epoch.transcript_hash
                || existing.private_package_hash != epoch.private_package_hash
                || existing.public_package_hash != epoch.public_package_hash
            {
                return Err("KEY_EPOCH_COLLISION".into());
            }
            let restored = self.decrypt_epoch(existing)?;
            let mut private_package = restored.private_package;
            private_package.zeroize();
            return Ok(());
        }
        self.atomic_write(&destination, &serde_json::to_vec(&epoch)?)
    }

    /// Activate exactly the epoch whose full-public-key transcript was agreed by all peers.
    pub fn activate(
        &self,
        key_id: &str,
        transcript_hash: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        validate_id(key_id)?;
        validate_sha256(transcript_hash)?;
        let epoch: EncryptedEpoch = serde_json::from_slice(&fs::read(self.epoch_path(key_id))?)?;
        if epoch.format_version != 1
            || epoch.participant_id != self.participant_id
            || epoch.key_id != key_id
            || epoch.transcript_hash != transcript_hash
        {
            return Err("KEY_EPOCH_ACTIVATION_BINDING_MISMATCH".into());
        }
        // Prove both ciphertexts are decryptable under the exact context before
        // making the pointer visible to startup recovery.
        let restored = self.decrypt_epoch(epoch.clone())?;
        let mut private_package = restored.private_package;
        private_package.zeroize();
        let active = ActiveEpoch {
            format_version: 1,
            participant_id: epoch.participant_id,
            key_id: epoch.key_id,
            threshold: epoch.threshold,
            total_participants: epoch.total_participants,
            transcript_hash: epoch.transcript_hash,
            public_package_hash: epoch.public_package_hash,
        };
        self.atomic_write(
            &self.directory.join("active-epoch.json"),
            &serde_json::to_vec(&active)?,
        )
    }

    /// Restore only the key epoch named by the atomically maintained active pointer.
    pub fn load_active(&self) -> Result<Option<RestoredEpoch>, Box<dyn std::error::Error>> {
        let active_path = self.directory.join("active-epoch.json");
        if !active_path.exists() {
            return Ok(None);
        }
        let active: ActiveEpoch = serde_json::from_slice(&fs::read(active_path)?)?;
        if active.format_version != 1 || active.participant_id != self.participant_id {
            return Err("ACTIVE_KEY_EPOCH_IDENTITY_MISMATCH".into());
        }
        validate_id(&active.key_id)?;
        validate_sha256(&active.transcript_hash)?;
        let epoch: EncryptedEpoch =
            serde_json::from_slice(&fs::read(self.epoch_path(&active.key_id))?)?;
        if epoch.format_version != 1
            || epoch.key_id != active.key_id
            || epoch.participant_id != active.participant_id
            || epoch.threshold != active.threshold
            || epoch.total_participants != active.total_participants
            || epoch.transcript_hash != active.transcript_hash
            || epoch.public_package_hash != active.public_package_hash
        {
            return Err("ACTIVE_KEY_EPOCH_METADATA_MISMATCH".into());
        }
        Ok(Some(self.decrypt_epoch(epoch)?))
    }

    fn decrypt_epoch(
        &self,
        epoch: EncryptedEpoch,
    ) -> Result<RestoredEpoch, Box<dyn std::error::Error>> {
        let private_context = self.context(
            &epoch.key_id,
            &epoch.transcript_hash,
            epoch.threshold,
            epoch.total_participants,
            "private",
        );
        let public_context = self.context(
            &epoch.key_id,
            &epoch.transcript_hash,
            epoch.threshold,
            epoch.total_participants,
            "public",
        );
        let encrypted_private = BASE64.decode(&epoch.encrypted_private_package)?;
        let encrypted_public = BASE64.decode(&epoch.encrypted_public_package)?;
        let mut private_package = self.decrypt(&encrypted_private, &private_context)?;
        let public_package = self.decrypt(&encrypted_public, &public_context)?;
        if sha256(&private_package) != epoch.private_package_hash
            || sha256(&public_package) != epoch.public_package_hash
        {
            private_package.zeroize();
            return Err("KEY_EPOCH_PACKAGE_HASH_MISMATCH".into());
        }
        Ok(RestoredEpoch {
            key_id: epoch.key_id,
            threshold: epoch.threshold,
            total_participants: epoch.total_participants,
            transcript_hash: epoch.transcript_hash,
            private_package,
            public_package,
        })
    }

    fn encrypt(
        &self,
        plaintext: &[u8],
        context: &KmsContext<'_>,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let result = self.kms_call("encrypt", plaintext, context)?;
        Ok(BASE64.decode(result)?)
    }

    fn decrypt(
        &self,
        ciphertext: &[u8],
        context: &KmsContext<'_>,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let result = self.kms_call("decrypt", ciphertext, context)?;
        Ok(BASE64.decode(result)?)
    }

    fn kms_call(
        &self,
        operation: &str,
        payload: &[u8],
        context: &KmsContext<'_>,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let request = KmsRequest {
            operation,
            payload: BASE64.encode(payload),
            encryption_context: context.clone(),
        };
        let mut child = Command::new(&self.python)
            .arg(&self.helper)
            .arg(&self.kms_key_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        serde_json::to_writer(
            child.stdin.as_mut().ok_or("KMS_HELPER_STDIN_UNAVAILABLE")?,
            &request,
        )?;
        drop(child.stdin.take());
        let output = child.wait_with_output()?;
        if !output.status.success() || output.stdout.len() > 16_384 {
            return Err("KMS_HELPER_FAILED".into());
        }
        let response: KmsResponse = serde_json::from_slice(&output.stdout)?;
        if !response.ok {
            return Err(response
                .error
                .unwrap_or_else(|| "KMS_OPERATION_FAILED".to_string())
                .into());
        }
        response
            .result
            .ok_or_else(|| "KMS_HELPER_RESULT_MISSING".into())
    }

    fn context<'a>(
        &'a self,
        key_id: &'a str,
        transcript_hash: &'a str,
        threshold: u16,
        total: u16,
        package_type: &'a str,
    ) -> KmsContext<'a> {
        KmsContext {
            application: "mini-dflow-frost-share-v1",
            participant_id: &self.participant_id,
            key_id,
            transcript_hash,
            threshold: threshold.to_string(),
            total_participants: total.to_string(),
            package_type,
        }
    }

    fn epoch_path(&self, key_id: &str) -> PathBuf {
        self.directory.join(format!("epoch-{key_id}.json"))
    }

    fn atomic_write(
        &self,
        destination: &Path,
        contents: &[u8],
    ) -> Result<(), Box<dyn std::error::Error>> {
        fs::create_dir_all(&self.directory)?;
        #[cfg(unix)]
        fs::set_permissions(
            &self.directory,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )?;
        let temporary = self.directory.join(format!(
            ".tmp-{}-{}",
            std::process::id(),
            destination
                .file_name()
                .ok_or("INVALID_KEY_STORE_PATH")?
                .to_string_lossy()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        if let Err(error) = fs::rename(&temporary, destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        fs::File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
}

fn validate_id(value: &str) -> Result<(), Box<dyn std::error::Error>> {
    if !(1..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("INVALID_KEY_EPOCH_ID".into());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), Box<dyn std::error::Error>> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("INVALID_TRANSCRIPT_HASH".into());
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
