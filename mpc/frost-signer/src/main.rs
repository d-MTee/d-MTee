mod grpc_server;
mod key_store;
mod participant_runtime;
mod peer_transport;

pub mod mpc_proto {
    include!(concat!(env!("OUT_DIR"), "/mpc.v1.rs"));
}

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use frost_ed25519 as frost;
use rand::rngs::OsRng;
use serde::Serialize;
use std::collections::BTreeMap;
use std::env;

use crate::grpc_server::GrpcServer;

const DEFAULT_DEMO_MESSAGE: &str = "mini-dflow real MPC proof";
const DEFAULT_PARTICIPANT_ID: &str = "p1";
const DEFAULT_PARTICIPANT_HOST: &str = "127.0.0.1";
const DEFAULT_PARTICIPANT_PORT: u16 = 9001;

#[derive(Serialize)]
struct ParticipantRuntimeStatus {
    status: String,
    participant_id: String,
    host: String,
    port: u16,
    threshold: u16,
    total_participants: u16,
    dkg_rounds_enabled: bool,
    signing_rounds_enabled: bool,
}

#[derive(Serialize)]
struct DemoResult {
    threshold: u16,
    participants: u16,
    public_key: String,
    message: String,
    signature: String,
    verified: bool,
}

fn print_usage() {
    eprintln!(
        "Usage: {} [demo|participant|help] [options]

Commands:
  demo [message]                  Run a local 2-of-3 FROST DKG and signing flow.
  participant                     Start the mTLS participant control plane (crypto rounds remain disabled).
  help                            Show this help text.

Participant options:
  --participant-id <id>   Identity for this signer process (default: p1)
  --host <host>           Bind address (default: 127.0.0.1)
  --port <port>           mTLS gRPC listener port (default: 9001)
  --threshold <n>         Required signing threshold (default: 2)
  --total <n>            Total participant count (default: 3)

Notes:
  - Message is optional and defaults to a demo payload.
  - Base64-encoded values are accepted for signed payloads.
  - Participant mode requires MPC_SERVER_CERT_PEM, MPC_SERVER_KEY_PEM,
    MPC_CLIENT_CA_PEM, MPC_COORDINATOR_CERT_SHA256, MPC_PEER_CERT_PINS_JSON,
    and MPC_PEER_ENDPOINTS_JSON.
",
        env::args().next().unwrap_or_else(|| "dflow-frost-signer".to_string())
    );
}

fn parse_message(raw: Option<String>) -> Vec<u8> {
    match raw {
        Some(value) => match BASE64.decode(&value) {
            Ok(decoded) => decoded,
            Err(_) => value.into_bytes(),
        },
        None => DEFAULT_DEMO_MESSAGE.as_bytes().to_vec(),
    }
}

fn parse_optional_u16(
    value: Option<String>,
    fallback: u16,
) -> Result<u16, Box<dyn std::error::Error>> {
    match value {
        Some(raw) => Ok(raw.parse::<u16>()?),
        None => Ok(fallback),
    }
}

fn run_participant_mode(
    args: &mut impl Iterator<Item = String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut participant_id = DEFAULT_PARTICIPANT_ID.to_string();
    let mut host = DEFAULT_PARTICIPANT_HOST.to_string();
    let mut port = DEFAULT_PARTICIPANT_PORT;
    let mut threshold = 2u16;
    let mut total_participants = 3u16;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--participant-id" => {
                participant_id = args.next().unwrap_or_else(|| participant_id.clone())
            }
            "--host" => host = args.next().unwrap_or_else(|| host.clone()),
            "--port" | "--grpc-port" => port = parse_optional_u16(args.next(), port)?,
            "--threshold" => threshold = parse_optional_u16(args.next(), threshold)?,
            "--total" => total_participants = parse_optional_u16(args.next(), total_participants)?,
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            _ => {
                if !arg.is_empty() {
                    eprintln!("ignoring unknown participant option: {arg}");
                }
            }
        }
    }

    let grpc_server = GrpcServer::new(&participant_id, threshold, total_participants)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&ParticipantRuntimeStatus {
            status: "mTLS-dkg-enabled-signing-disabled".to_string(),
            participant_id: participant_id.clone(),
            host: host.clone(),
            port,
            threshold,
            total_participants,
            dkg_rounds_enabled: true,
            signing_rounds_enabled: false,
        })?
    );

    let runtime = tokio::runtime::Runtime::new()?;
    let grpc_addr: std::net::SocketAddr = format!("{}:{}", host, port).parse()?;
    runtime.block_on(grpc_server.serve(grpc_addr))?;
    Ok(())
}

fn dkg_2_of_3() -> Result<
    (
        BTreeMap<frost::Identifier, frost::keys::KeyPackage>,
        frost::keys::PublicKeyPackage,
    ),
    Box<dyn std::error::Error>,
> {
    let mut rng = OsRng;
    let n = 3u16;
    let t = 2u16;

    let mut r1_secret = BTreeMap::new();
    let mut r1_recv: BTreeMap<
        frost::Identifier,
        BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package>,
    > = BTreeMap::new();

    for i in 1..=n {
        let id: frost::Identifier = i.try_into()?;
        let (secret, package) = frost::keys::dkg::part1(id, n, t, &mut rng)?;
        r1_secret.insert(id, secret);
        for j in 1..=n {
            let rid: frost::Identifier = j.try_into()?;
            if i != j {
                r1_recv.entry(rid).or_default().insert(id, package.clone());
            }
        }
    }

    let mut r2_secret = BTreeMap::new();
    let mut r2_recv: BTreeMap<
        frost::Identifier,
        BTreeMap<frost::Identifier, frost::keys::dkg::round2::Package>,
    > = BTreeMap::new();

    for i in 1..=n {
        let id: frost::Identifier = i.try_into()?;
        let (secret, packages) =
            frost::keys::dkg::part2(r1_secret.remove(&id).unwrap(), &r1_recv[&id])?;
        r2_secret.insert(id, secret);
        for (rid, package) in packages {
            r2_recv.entry(rid).or_default().insert(id, package);
        }
    }

    let mut keys = BTreeMap::new();
    let mut pubs = BTreeMap::new();

    for i in 1..=n {
        let id: frost::Identifier = i.try_into()?;
        let (kp, pp) = frost::keys::dkg::part3(&r2_secret[&id], &r1_recv[&id], &r2_recv[&id])?;
        keys.insert(id, kp);
        pubs.insert(id, pp);
    }

    let public = pubs.values().next().unwrap().clone();
    Ok((keys, public))
}

fn sign_2_of_3(
    keys: &BTreeMap<frost::Identifier, frost::keys::KeyPackage>,
    public: &frost::keys::PublicKeyPackage,
    message: &[u8],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut rng = OsRng;
    let selected: Vec<_> = [1u16, 2u16]
        .into_iter()
        .map(|i| i.try_into())
        .collect::<Result<_, _>>()?;

    let mut nonces = BTreeMap::new();
    let mut commitments = BTreeMap::new();

    for id in &selected {
        let (nonce, commitment) = frost::round1::commit(keys[id].signing_share(), &mut rng);
        nonces.insert(*id, nonce);
        commitments.insert(*id, commitment);
    }

    let package = frost::SigningPackage::new(commitments, message);
    let mut shares = BTreeMap::new();

    for id in &selected {
        shares.insert(*id, frost::round2::sign(&package, &nonces[id], &keys[id])?);
    }

    let sig = frost::aggregate(&package, &shares, public)?;
    public.verifying_key().verify(message, &sig)?;

    Ok(sig.serialize()?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "demo".to_string());

    match command.as_str() {
        "demo" => {
            let (keys, public) = dkg_2_of_3()?;
            let msg_bytes = parse_message(args.next());

            let sig = sign_2_of_3(&keys, &public, &msg_bytes)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&DemoResult {
                    threshold: 2,
                    participants: 3,
                    public_key: hex::encode(public.verifying_key().serialize()?),
                    message: String::from_utf8_lossy(&msg_bytes).into_owned(),
                    signature: hex::encode(sig),
                    verified: true,
                })?
            );
        }
        "participant" => {
            run_participant_mode(&mut args)?;
        }
        "help" | "-h" | "--help" => print_usage(),
        _ => {
            print_usage();
            return Err(format!(
                "unknown command: {command}. Expected one of: demo, participant, help"
            )
            .into());
        }
    }

    Ok(())
}
