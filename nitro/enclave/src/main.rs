use aws_nitro_enclaves_nsm_api::{api::{Request, Response}, driver::{nsm_init, nsm_process_request, nsm_exit}};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_vsock::{VsockAddr, VsockListener};
use zeroize::Zeroize;

#[derive(Deserialize)] struct RequestBody { op: String, message: Option<String>, nonce: Option<String> }
#[derive(Serialize)] struct ResponseBody { ok: bool, attestation: Option<String>, signature: Option<String>, public_key: Option<String>, digest: Option<String>, error: Option<String> }

fn attestation(nonce: &[u8], public_key: &[u8]) -> Result<Vec<u8>, String> {
    let fd = nsm_init();
    if fd < 0 { return Err("NSM_INIT_FAILED".into()); }
    let result = nsm_process_request(fd, Request::Attestation { user_data: None, nonce: Some(nonce.to_vec().into()), public_key: Some(public_key.to_vec().into()) });
    nsm_exit(fd);
    match result { Response::Attestation { document } => Ok(document), Response::Error(e) => Err(format!("NSM_ATTESTATION_FAILED:{e:?}")), _ => Err("NSM_UNEXPECTED_RESPONSE".into()) }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key = signing_key.verifying_key().to_bytes();
    let listener = VsockListener::bind(VsockAddr::new(tokio_vsock::VMADDR_CID_ANY, 5000))?;
    eprintln!("nitro signer listening on vsock:5000");
    loop {
        let (stream, _) = listener.accept().await?;
        let key = signing_key.clone();
        tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(stream);
            let mut lines = BufReader::new(r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let reply = match serde_json::from_str::<RequestBody>(&line) {
                    Ok(req) if req.op == "attest" => {
                        let nonce = req.nonce.map(|x| STANDARD.decode(x).unwrap_or_default()).unwrap_or_else(|| Sha256::digest(b"mini-dflow-attestation").to_vec());
                        match attestation(&nonce, &public_key) { Ok(doc) => ResponseBody{ok:true,attestation:Some(STANDARD.encode(doc)),signature:None,public_key:Some(STANDARD.encode(public_key)),digest:None,error:None}, Err(e)=>ResponseBody{ok:false,attestation:None,signature:None,public_key:None,digest:None,error:Some(e)} }
                    }
                    Ok(req) if req.op == "sign" => {
                        match req.message.and_then(|x| STANDARD.decode(x).ok()) {
                            Some(msg) => { let sig=key.sign(&msg); let digest=hex::encode(Sha256::digest(&msg)); ResponseBody{ok:true,attestation:None,signature:Some(STANDARD.encode(sig.to_bytes())),public_key:Some(STANDARD.encode(public_key)),digest:Some(digest),error:None} }
                            None => ResponseBody{ok:false,attestation:None,signature:None,public_key:None,digest:None,error:Some("MESSAGE_REQUIRED".into())}
                        }
                    }
                    Ok(_) => ResponseBody{ok:false,attestation:None,signature:None,public_key:None,digest:None,error:Some("UNKNOWN_OPERATION".into())},
                    Err(e) => ResponseBody{ok:false,attestation:None,signature:None,public_key:None,digest:None,error:Some(e.to_string())}
                };
                let mut out=serde_json::to_vec(&reply).unwrap(); out.push(b'\n'); if w.write_all(&out).await.is_err(){break;}
            }
        });
    }
}

fn hex(bytes: impl AsRef<[u8]>) -> String { bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect() }
