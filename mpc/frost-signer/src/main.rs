use frost_ed25519 as frost;
use rand::rngs::OsRng;
use serde::Serialize;
use base64;
use std::collections::BTreeMap;
use std::env;

#[derive(Serialize)]
struct DemoResult { threshold: u16, participants: u16, public_key: String, message: String, signature: String, verified: bool }

fn dkg_2_of_3() -> Result<(BTreeMap<frost::Identifier, frost::keys::KeyPackage>, frost::keys::PublicKeyPackage), Box<dyn std::error::Error>> {
    let mut rng = OsRng;
    let n = 3u16; let t = 2u16;
    let mut r1_secret = BTreeMap::new();
    let mut r1_recv: BTreeMap<frost::Identifier, BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package>> = BTreeMap::new();
    for i in 1..=n {
        let id: frost::Identifier = i.try_into()?;
        let (secret, package) = frost::keys::dkg::part1(id, n, t, &mut rng)?;
        r1_secret.insert(id, secret);
        for j in 1..=n { let rid: frost::Identifier = j.try_into()?; if i != j { r1_recv.entry(rid).or_default().insert(id, package.clone()); } }
    }
    let mut r2_secret = BTreeMap::new();
    let mut r2_recv: BTreeMap<frost::Identifier, BTreeMap<frost::Identifier, frost::keys::dkg::round2::Package>> = BTreeMap::new();
    for i in 1..=n {
        let id: frost::Identifier = i.try_into()?;
        let (secret, packages) = frost::keys::dkg::part2(r1_secret.remove(&id).unwrap(), &r1_recv[&id])?;
        r2_secret.insert(id, secret);
        for (rid, package) in packages { r2_recv.entry(rid).or_default().insert(id, package); }
    }
    let mut keys = BTreeMap::new();
    let mut pubs = BTreeMap::new();
    for i in 1..=n {
        let id: frost::Identifier = i.try_into()?;
        let (kp, pp) = frost::keys::dkg::part3(&r2_secret[&id], &r1_recv[&id], &r2_recv[&id])?;
        keys.insert(id, kp); pubs.insert(id, pp);
    }
    let public = pubs.values().next().unwrap().clone();
    Ok((keys, public))
}

fn sign_2_of_3(keys: &BTreeMap<frost::Identifier, frost::keys::KeyPackage>, public: &frost::keys::PublicKeyPackage, message: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut rng = OsRng;
    let selected: Vec<_> = [1u16,2u16].into_iter().map(|i| i.try_into()).collect::<Result<_,_>>()?;
    let mut nonces = BTreeMap::new(); let mut commitments = BTreeMap::new();
    for id in &selected { let (n,c)=frost::round1::commit(keys[id].signing_share(), &mut rng); nonces.insert(*id,n); commitments.insert(*id,c); }
    let package = frost::SigningPackage::new(commitments, message);
    let mut shares = BTreeMap::new();
    for id in &selected { shares.insert(*id, frost::round2::sign(&package, &nonces[id], &keys[id])?); }
    let sig = frost::aggregate(&package, &shares, public)?;
    public.verifying_key().verify(message, &sig)?;
    Ok(sig.serialize().to_vec())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command = env::args().nth(1).unwrap_or_else(|| "demo".into());
    let requested_message = env::args().nth(2);
    match command.as_str() {
        "demo" => {
            let (keys, public) = dkg_2_of_3()?;
            let msg_vec = requested_message.map(|s| base64::decode(s)).transpose()?.unwrap_or_else(|| b"mini-dflow real MPC proof".to_vec());
            let msg = msg_vec.as_slice();
            let sig = sign_2_of_3(&keys, &public, msg)?;
            println!("{}", serde_json::to_string_pretty(&DemoResult { threshold:2, participants:3, public_key:hex::encode(public.verifying_key().serialize()), message:String::from_utf8_lossy(msg).into(), signature:hex::encode(sig), verified:true })?);
        }
        _ => return Err(format!("unknown command: {command}").into())
    }
    Ok(())
}
