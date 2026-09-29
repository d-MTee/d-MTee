use aws_nitro_enclaves_nsm_api::{
    api::{Request, Response},
    driver::{nsm_exit, nsm_init, nsm_process_request},
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rsa::pkcs8::EncodePublicKey;
use rsa::{Oaep, RsaPrivateKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_vsock::{VsockAddr, VsockListener, VsockStream};
use zeroize::Zeroize;

#[derive(Deserialize)]
struct RequestBody {
    op: String,
    message: Option<String>,
    nonce: Option<String>,
    user_data: Option<String>,
    authorization: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyAuthorization {
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
    expires_at: u64,
    nonce: String,
}
#[derive(Serialize)]
struct ResponseBody {
    ok: bool,
    attestation: Option<String>,
    signature: Option<String>,
    public_key: Option<String>,
    digest: Option<String>,
    error: Option<String>,
}

fn attestation(
    nonce: &[u8],
    public_key: &[u8],
    user_data: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let fd = nsm_init();
    if fd < 0 {
        return Err("NSM_INIT_FAILED".into());
    }
    let result = nsm_process_request(
        fd,
        Request::Attestation {
            user_data: user_data.map(|value| value.to_vec().into()),
            nonce: Some(nonce.to_vec().into()),
            public_key: Some(public_key.to_vec().into()),
        },
    );
    nsm_exit(fd);
    match result {
        Response::Attestation { document } => Ok(document),
        Response::Error(e) => Err(format!("NSM_ATTESTATION_FAILED:{e:?}")),
        _ => Err("NSM_UNEXPECTED_RESPONSE".into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // A stable signing seed is unwrapped by KMS only for this attested enclave.
    // The parent receives only CiphertextForRecipient and cannot read the seed.
    let seed = load_kms_seed().await?;
    let signing_key = SigningKey::from_bytes(&seed);
    let mut seed_to_zeroize = seed;
    seed_to_zeroize.zeroize();
    let public_key = signing_key.verifying_key().to_bytes();
    let policy_key_hex = env::var("NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX")?;
    let policy_key_bytes: [u8; 32] = hex::decode(policy_key_hex)?
        .try_into()
        .map_err(|_| "policy authority key must be 32 bytes")?;
    let policy_key = VerifyingKey::from_bytes(&policy_key_bytes)?;
    let participant_id = env::var("NITRO_PARTICIPANT_ID")?;
    let key_id = env::var("NITRO_SIGNING_KEY_ID")?;
    if participant_id.is_empty() || key_id.is_empty() {
        return Err("NITRO_PARTICIPANT_ID and NITRO_SIGNING_KEY_ID are required".into());
    }
    let used_authorizations = Arc::new(Mutex::new(HashMap::<String, u64>::new()));
    let listener = VsockListener::bind(VsockAddr::new(tokio_vsock::VMADDR_CID_ANY, 5000))?;
    eprintln!("nitro signer listening on vsock:5000");
    loop {
        let (stream, _) = listener.accept().await?;
        let key = signing_key.clone();
        let policy_key = policy_key.clone();
        let expected_participant = participant_id.clone();
        let expected_key_id = key_id.clone();
        let used_authorizations = used_authorizations.clone();
        tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(stream);
            let mut lines = BufReader::new(r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let reply = match serde_json::from_str::<RequestBody>(&line) {
                    Ok(req) if req.op == "attest" => {
                        let nonce = req
                            .nonce
                            .and_then(|x| STANDARD.decode(x).ok())
                            .filter(|x| x.len() >= 16 && x.len() <= 64)
                            .unwrap_or_default();
                        if nonce.is_empty() {
                            ResponseBody {
                                ok: false,
                                attestation: None,
                                signature: None,
                                public_key: None,
                                digest: None,
                                error: Some("NONCE_REQUIRED".into()),
                            }
                        } else {
                            let user_data = req.user_data.and_then(|x| STANDARD.decode(x).ok());
                            match attestation(&nonce, &public_key, user_data.as_deref()) {
                                Ok(doc) => ResponseBody {
                                    ok: true,
                                    attestation: Some(STANDARD.encode(doc)),
                                    signature: None,
                                    public_key: Some(STANDARD.encode(public_key)),
                                    digest: None,
                                    error: None,
                                },
                                Err(e) => ResponseBody {
                                    ok: false,
                                    attestation: None,
                                    signature: None,
                                    public_key: None,
                                    digest: None,
                                    error: Some(e),
                                },
                            }
                        }
                    }
                    Ok(req) if req.op == "sign" => {
                        match (
                            req.message.and_then(|x| STANDARD.decode(x).ok()),
                            req.authorization,
                        ) {
                            (Some(msg), Some(token)) => match verify_policy_authorization(
                                &policy_key,
                                &token,
                                &msg,
                                &expected_participant,
                                &expected_key_id,
                            ) {
                                Ok((nonce, expires_at)) => {
                                    let mut used = used_authorizations.lock().unwrap();
                                    let now = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis()
                                        as u64;
                                    used.retain(|_, expiry| *expiry >= now);
                                    if used.contains_key(&nonce) {
                                        ResponseBody {
                                            ok: false,
                                            attestation: None,
                                            signature: None,
                                            public_key: None,
                                            digest: None,
                                            error: Some("AUTHORIZATION_REPLAYED".into()),
                                        }
                                    } else {
                                        used.insert(nonce, expires_at);
                                        let sig = key.sign(&msg);
                                        ResponseBody {
                                            ok: true,
                                            attestation: None,
                                            signature: Some(STANDARD.encode(sig.to_bytes())),
                                            public_key: Some(STANDARD.encode(public_key)),
                                            digest: Some(hex::encode(Sha256::digest(&msg))),
                                            error: None,
                                        }
                                    }
                                }
                                Err(error) => ResponseBody {
                                    ok: false,
                                    attestation: None,
                                    signature: None,
                                    public_key: None,
                                    digest: None,
                                    error: Some(error),
                                },
                            },
                            (Some(_), None) => ResponseBody {
                                ok: false,
                                attestation: None,
                                signature: None,
                                public_key: None,
                                digest: None,
                                error: Some("POLICY_AUTHORIZATION_REQUIRED".into()),
                            },
                            _ => ResponseBody {
                                ok: false,
                                attestation: None,
                                signature: None,
                                public_key: None,
                                digest: None,
                                error: Some("MESSAGE_REQUIRED".into()),
                            },
                        }
                    }
                    Ok(req) if req.op == "identity" => ResponseBody {
                        ok: true,
                        attestation: None,
                        signature: None,
                        public_key: Some(STANDARD.encode(public_key)),
                        digest: None,
                        error: None,
                    },
                    Ok(_) => ResponseBody {
                        ok: false,
                        attestation: None,
                        signature: None,
                        public_key: None,
                        digest: None,
                        error: Some("UNKNOWN_OPERATION".into()),
                    },
                    Err(e) => ResponseBody {
                        ok: false,
                        attestation: None,
                        signature: None,
                        public_key: None,
                        digest: None,
                        error: Some(e.to_string()),
                    },
                };
                let mut out = serde_json::to_vec(&reply).unwrap();
                out.push(b'\n');
                if w.write_all(&out).await.is_err() {
                    break;
                }
            }
        });
    }
}

fn verify_policy_authorization(
    public_key: &VerifyingKey,
    token: &str,
    message: &[u8],
    participant_id: &str,
    key_id: &str,
) -> Result<(String, u64), String> {
    if token.len() > 8192 || message.len() > 1232 {
        return Err("POLICY_REQUEST_TOO_LARGE".into());
    }
    let mut parts = token.split('.');
    let payload = URL_SAFE_NO_PAD
        .decode(parts.next().ok_or("POLICY_TOKEN_INVALID")?)
        .map_err(|_| "POLICY_TOKEN_INVALID")?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(parts.next().ok_or("POLICY_TOKEN_INVALID")?)
        .map_err(|_| "POLICY_TOKEN_INVALID")?;
    if parts.next().is_some() {
        return Err("POLICY_TOKEN_INVALID".into());
    }
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| "POLICY_SIGNATURE_INVALID")?;
    public_key
        .verify_strict(&payload, &signature)
        .map_err(|_| "POLICY_SIGNATURE_INVALID")?;
    let claims: PolicyAuthorization =
        serde_json::from_slice(&payload).map_err(|_| "POLICY_CLAIMS_INVALID")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "CLOCK_INVALID")?
        .as_millis() as u64;
    if claims.version != 1 || claims.participant_id != participant_id || claims.key_id != key_id {
        return Err("POLICY_IDENTITY_MISMATCH".into());
    }
    if claims.transaction_message_hash != hex::encode(Sha256::digest(message)) {
        return Err("POLICY_TRANSACTION_MISMATCH".into());
    }
    if claims.expires_at < now || claims.expires_at > now + 60_000 {
        return Err("POLICY_AUTHORIZATION_EXPIRED".into());
    }
    if claims.request_id.len() < 16
        || claims.approval_id.is_empty()
        || claims.route_hash.is_empty()
        || claims.policy_hash.is_empty()
        || claims.chain_id.is_empty()
        || claims.wallet_id.is_empty()
        || claims.amount.is_empty()
        || claims.input_token.is_empty()
        || claims.output_token.is_empty()
        || claims.max_slippage_bps == 0
        || claims.nonce.len() < 16
    {
        return Err("POLICY_CLAIMS_INCOMPLETE".into());
    }
    Ok((claims.nonce, claims.expires_at))
}

async fn load_kms_seed() -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let mut rng = OsRng;
    let recipient_private = RsaPrivateKey::new(&mut rng, 2048)?;
    let recipient_public = recipient_private
        .to_public_key()
        .to_public_key_der()?
        .as_bytes()
        .to_vec();
    let mut nonce = [0u8; 32];
    use rand::RngCore;
    rng.fill_bytes(&mut nonce);
    let attestation_doc = attestation(&nonce, &recipient_public, None)?;
    let mut stream = VsockStream::connect(VsockAddr::new(3, 5001)).await?;
    let request =
        serde_json::json!({"op":"kms-decrypt","attestation":STANDARD.encode(attestation_doc)});
    stream
        .write_all(format!("{}\n", request).as_bytes())
        .await?;
    let mut lines = BufReader::new(stream).lines();
    let response = lines
        .next_line()
        .await?
        .ok_or("KMS broker closed connection")?;
    let value: serde_json::Value = serde_json::from_str(&response)?;
    if value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("KMS_DECRYPT_FAILED")
            .into());
    }
    let encrypted = STANDARD.decode(
        value
            .get("ciphertextForRecipient")
            .and_then(|v| v.as_str())
            .ok_or("KMS_RESPONSE_MISSING_CIPHERTEXT")?,
    )?;
    let mut plaintext = recipient_private.decrypt(Oaep::new::<sha2::Sha256>(), &encrypted)?;
    if plaintext.len() != 32 {
        plaintext.zeroize();
        return Err("KMS_SIGNING_SEED_MUST_BE_32_BYTES".into());
    }
    let seed: [u8; 32] = plaintext.as_slice().try_into()?;
    plaintext.zeroize();
    Ok(seed)
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
