use base64;
use frost_ed25519 as frost;
use rand::rngs::OsRng;
use serde::Serialize;
use std::collections::BTreeMap;
use std::env;

const DEFAULT_DEMO_MESSAGE: &str = "mini-dflow real MPC proof";

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
        "Usage: {} [demo|help] [message]

Commands:
  demo [message]   Run a local 2-of-3 FROST DKG and signing flow.
  help             Show this help text.

Notes:
  - Message is optional and defaults to a demo payload.
  - Base64-encoded values are accepted for signed payloads.
",
        env::args().next().unwrap_or_else(|| "dflow-frost-signer".to_string())
    );
}

fn parse_message(raw: Option<String>) -> Vec<u8> {
    match raw {
        Some(value) => match base64::decode(&value) {
            Ok(decoded) => decoded,
            Err(_) => value.into_bytes(),
        },
        None => DEFAULT_DEMO_MESSAGE.as_bytes().to_vec(),
    }
}

fn dkg_2_of_3() -> Result<(BTreeMap<frost::Identifier, frost::keys::KeyPackage>, frost::keys::PublicKeyPackage), Box<dyn std::error::Error>> {
    let mut rng = OsRng;
    let n = 3u16;
    let t = 2u16;

    let mut r1_secret = BTreeMap::new();
    let mut r1_recv: BTreeMap<frost::Identifier, BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package>> = BTreeMap::new();

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
    let mut r2_recv: BTreeMap<frost::Identifier, BTreeMap<frost::Identifier, frost::keys::dkg::round2::Package>> = BTreeMap::new();

    for i in 1..=n {
        let id: frost::Identifier = i.try_into()?;
        let (secret, packages) = frost::keys::dkg::part2(r1_secret.remove(&id).unwrap(), &r1_recv[&id])?;
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

    Ok(sig.serialize().to_vec())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "demo".to_string());
    let requested_message = args.next();

    match command.as_str() {
        "demo" => {
            let (keys, public) = dkg_2_of_3()?;
            let msg_bytes = parse_message(requested_message);

            let sig = sign_2_of_3(&keys, &public, &msg_bytes)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&DemoResult {
                    threshold: 2,
                    participants: 3,
                    public_key: hex::encode(public.verifying_key().serialize()),
                    message: String::from_utf8_lossy(&msg_bytes).into_owned(),
                    signature: hex::encode(sig),
                    verified: true,
                })?
            );
        }
        "help" | "-h" | "--help" => print_usage(),
        _ => {
            print_usage();
            return Err(format!("unknown command: {command}. Expected one of: demo, help").into());
        }
    }

    Ok(())
}
