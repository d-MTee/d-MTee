//! Independent policy-token and durable nonce checks at each signer.
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claims {
    version: u8,
    participant_id: String,
    request_id: String,
    key_id: String,
    transaction_message_hash: String,
    approval_id: String,
    route_hash: String,
    policy_hash: String,
    chain_id: String,
    wallet_id: String,
    amount: String,
    input_token: String,
    output_token: String,
    max_slippage_bps: u64,
    #[serde(default)]
    last_valid_block_height: Option<u64>,
    expires_at: u64,
    nonce: String,
}

/// Verify signed claims against the exact participant request and atomically
/// record the policy nonce. Repeated RPC rounds are allowed only for the same
/// token and session; a nonce cannot authorize another request.
pub fn verify_and_claim(
    participant_id: &str,
    session_id: &str,
    request_id: &str,
    key_id: &str,
    message: &[u8],
    token: &str,
) -> Result<(), String> {
    if token.len() > 8192 || session_id != request_id {
        return Err("INVALID_SIGNING_AUTHORIZATION".into());
    }
    let mut parts = token.split('.');
    let payload_part = parts.next().ok_or("POLICY_TOKEN_INVALID")?;
    let signature_part = parts.next().ok_or("POLICY_TOKEN_INVALID")?;
    if parts.next().is_some() || payload_part.is_empty() || signature_part.is_empty() {
        return Err("POLICY_TOKEN_INVALID".into());
    }
    let payload = URL_SAFE_NO_PAD
        .decode(payload_part)
        .map_err(|_| "POLICY_TOKEN_INVALID")?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_part)
        .map_err(|_| "POLICY_TOKEN_INVALID")?;
    let public_hex = std::env::var("MPC_POLICY_AUTHORITY_PUBLIC_KEY_HEX")
        .map_err(|_| "POLICY_AUTHORITY_NOT_CONFIGURED")?;
    let public_bytes = hex::decode(public_hex.strip_prefix("0x").unwrap_or(&public_hex))
        .map_err(|_| "POLICY_AUTHORITY_KEY_INVALID")?;
    let public_array: [u8; 32] = public_bytes
        .try_into()
        .map_err(|_| "POLICY_AUTHORITY_KEY_INVALID")?;
    let verifying_key =
        VerifyingKey::from_bytes(&public_array).map_err(|_| "POLICY_AUTHORITY_KEY_INVALID")?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| "POLICY_SIGNATURE_INVALID")?;
    verifying_key
        .verify(&payload, &signature)
        .map_err(|_| "POLICY_SIGNATURE_INVALID")?;

    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| "POLICY_CLAIMS_INVALID")?;
    let message_hash = hex::encode(Sha256::digest(message));
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "SYSTEM_CLOCK_INVALID")?
        .as_millis() as u64;
    if claims.version != 1
        || claims.participant_id != participant_id
        || claims.request_id != request_id
        || claims.key_id != key_id
        || claims.transaction_message_hash != message_hash
        || claims.approval_id.is_empty()
        || claims.route_hash.is_empty()
        || claims.policy_hash.is_empty()
        || claims.chain_id.is_empty()
        || claims.wallet_id.is_empty()
        || claims.input_token.is_empty()
        || claims.output_token.is_empty()
        || claims
            .amount
            .parse::<f64>()
            .map_or(true, |amount| !amount.is_finite() || amount <= 0.0)
        || claims.max_slippage_bps == 0
        || claims.max_slippage_bps > 10_000
        || claims.expires_at < now_ms
        || claims.expires_at > now_ms.saturating_add(60_000)
        || claims.nonce.len() < 16
        || claims.nonce.len() > 256
        || (claims.last_valid_block_height == Some(0))
    {
        return Err("POLICY_AUTHORIZATION_BINDING_OR_EXPIRY_INVALID".into());
    }

    let nonce_hash = hex::encode(Sha256::digest(claims.nonce.as_bytes()));
    let directory = PathBuf::from(
        std::env::var("MPC_SIGNING_NONCE_DIR").map_err(|_| "SIGNING_NONCE_STORE_NOT_CONFIGURED")?,
    );
    fs::create_dir_all(&directory).map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
    }
    let identity_hash = hex::encode(Sha256::digest(
        format!("{participant_id}:{key_id}").as_bytes(),
    ));
    cleanup_expired_nonce_claims(&directory, &identity_hash, now_ms);
    let file = directory.join(format!("nonce-{identity_hash}-{nonce_hash}"));
    if file.with_extension("used").exists() {
        return Err("SIGNING_POLICY_NONCE_REPLAYED".into());
    }
    let claim_record = format!(
        "{}\n{}\n{}\npending\n",
        request_id,
        hex::encode(Sha256::digest(token.as_bytes())),
        claims.expires_at,
    );
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    match options.open(&file) {
        Ok(mut handle) => {
            handle
                .write_all(claim_record.as_bytes())
                .map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
            handle
                .sync_all()
                .map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
            fs::File::open(&directory)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing =
                fs::read_to_string(&file).map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
            if existing != claim_record {
                return Err("SIGNING_POLICY_NONCE_REPLAYED".into());
            }
        }
        Err(_) => return Err("SIGNING_NONCE_STORE_UNAVAILABLE".into()),
    }
    Ok(())
}

/// Permanently mark a nonce consumed once the participant emitted its share.
pub fn mark_consumed(participant_id: &str, key_id: &str, token: &str) -> Result<(), String> {
    let (payload_part, _) = token.split_once('.').ok_or("POLICY_TOKEN_INVALID")?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_part)
        .map_err(|_| "POLICY_TOKEN_INVALID")?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| "POLICY_CLAIMS_INVALID")?;
    if claims.participant_id != participant_id || claims.key_id != key_id {
        return Err("POLICY_AUTHORIZATION_BINDING_MISMATCH".into());
    }
    let directory = PathBuf::from(
        std::env::var("MPC_SIGNING_NONCE_DIR").map_err(|_| "SIGNING_NONCE_STORE_NOT_CONFIGURED")?,
    );
    let identity_hash = hex::encode(Sha256::digest(
        format!("{participant_id}:{key_id}").as_bytes(),
    ));
    let nonce_hash = hex::encode(Sha256::digest(claims.nonce.as_bytes()));
    let claim_file = directory.join(format!("nonce-{identity_hash}-{nonce_hash}"));
    let expected = format!(
        "{}\n{}\n{}\npending\n",
        claims.request_id,
        hex::encode(Sha256::digest(token.as_bytes())),
        claims.expires_at,
    );
    let existing = fs::read_to_string(&claim_file).map_err(|_| "SIGNING_NONCE_CLAIM_MISSING")?;
    if existing
        == format!(
            "{}\n{}\n{}\nconsumed\n",
            claims.request_id,
            hex::encode(Sha256::digest(token.as_bytes())),
            claims.expires_at,
        )
    {
        return Ok(());
    }
    if existing != expected {
        return Err("SIGNING_POLICY_NONCE_REPLAYED".into());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut used = options
        .open(claim_file.with_extension("used"))
        .map_err(|_| "SIGNING_POLICY_NONCE_REPLAYED")?;
    used.write_all(b"consumed\n")
        .and_then(|_| used.sync_all())
        .map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
    fs::File::open(&directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "SIGNING_NONCE_STORE_UNAVAILABLE")?;
    Ok(())
}

fn cleanup_expired_nonce_claims(directory: &std::path::Path, identity_hash: &str, now_ms: u64) {
    let prefix = format!("nonce-{identity_hash}-");
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&prefix) && !name.ends_with(".used"))
        {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        let expires_at = contents
            .lines()
            .nth(2)
            .and_then(|value| value.parse::<u64>().ok());
        if expires_at.is_some_and(|expires_at| expires_at < now_ms) {
            let _ = fs::remove_file(path.with_extension("used"));
            let _ = fs::remove_file(path);
        }
    }
}
