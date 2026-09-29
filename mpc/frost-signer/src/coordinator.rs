//! One-shot signing coordinator. It handles only public commitments, shares,
//! and packages; every signer independently authorizes and nonce-checks.
use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use frost_ed25519 as frost;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tonic::transport::{Certificate, ClientTlsConfig, Identity};

use crate::mpc_proto::participant_signer_client::ParticipantSignerClient;
use crate::mpc_proto::{
    DkgFinalizeRequest, SignRound1Request, SignRound2Request, SignerCommitment,
};

#[derive(Deserialize)]
struct Endpoint {
    endpoint: String,
    server_name: String,
    ca_pem_path: String,
    ca_sha256: String,
}

#[derive(Deserialize)]
struct SignRequest {
    request_id: String,
    key_id: String,
    message_base64: String,
    threshold: usize,
    participant_ids: Vec<String>,
    policy_authorizations: BTreeMap<String, String>,
}

#[derive(Serialize)]
struct SignResponse {
    request_id: String,
    key_id: String,
    transaction_message_hash: String,
    signature_hex: String,
    group_public_key_hex: String,
    verified: bool,
    participants: Vec<String>,
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(256 * 1024 + 1)
        .read_to_end(&mut input)?;
    if input.len() > 256 * 1024 {
        return Err("COORDINATOR_INPUT_TOO_LARGE".into());
    }
    let request: SignRequest = serde_json::from_slice(&input)?;
    if request.request_id.len() < 16
        || request.request_id.len() > 128
        || request.key_id.is_empty()
        || request.threshold < 2
        || request.participant_ids.len() < request.threshold
        || request.participant_ids.len() > 16
    {
        return Err("INVALID_COORDINATOR_SIGNING_REQUEST".into());
    }
    let message = STANDARD.decode(&request.message_base64)?;
    if message.is_empty() || message.len() > 1232 {
        return Err("INVALID_TRANSACTION_MESSAGE".into());
    }
    let endpoints: BTreeMap<String, Endpoint> =
        serde_json::from_str(&std::env::var("MPC_PEER_ENDPOINTS_JSON")?)?;
    let cert = std::fs::read(std::env::var("MPC_COORDINATOR_CERT_PEM")?)?;
    let key = std::fs::read(std::env::var("MPC_COORDINATOR_KEY_PEM")?)?;
    let identity = Identity::from_pem(cert, key);
    let mut participants = request.participant_ids.clone();
    participants.sort();
    participants.dedup();
    if participants.len() < request.threshold || participants.len() != request.participant_ids.len()
    {
        return Err("INVALID_PARTICIPANT_ROSTER".into());
    }

    let mut clients = Vec::new();
    let mut pinned_ca_hashes = HashSet::new();
    for participant_id in &participants {
        let endpoint = endpoints
            .get(participant_id)
            .ok_or("PARTICIPANT_ENDPOINT_NOT_CONFIGURED")?;
        let ca_bytes = std::fs::read(&endpoint.ca_pem_path)?;
        let ca_hash = hex::encode(Sha256::digest(&ca_bytes));
        if endpoint.ca_sha256.len() != 64
            || ca_hash != endpoint.ca_sha256.to_ascii_lowercase()
            || !pinned_ca_hashes.insert(ca_hash)
        {
            return Err("PARTICIPANT_CA_PIN_MISMATCH".into());
        }
        let ca = Certificate::from_pem(ca_bytes);
        let tls = ClientTlsConfig::new()
            .ca_certificate(ca)
            .identity(identity.clone())
            .domain_name(endpoint.server_name.clone());
        let channel = tonic::transport::Endpoint::from_shared(endpoint.endpoint.clone())?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .tls_config(tls)?
            .connect()
            .await?;
        clients.push((
            participant_id.clone(),
            ParticipantSignerClient::new(channel),
        ));
    }

    let mut public_package_bytes: Option<Vec<u8>> = None;
    let mut commitments = BTreeMap::new();
    for (participant_id, client) in &mut clients {
        let policy_authorization = request
            .policy_authorizations
            .get(participant_id)
            .ok_or("PARTICIPANT_POLICY_TOKEN_REQUIRED")?;
        let response = client
            .dkg_finalize(DkgFinalizeRequest {
                session_id: request.key_id.clone(),
                participant_id: participant_id.clone(),
            })
            .await?
            .into_inner();
        if !response.ok {
            return Err("PARTICIPANT_KEY_EPOCH_NOT_READY".into());
        }
        if let Some(existing) = &public_package_bytes {
            if existing != &response.public_key_package {
                return Err("PARTICIPANTS_DISAGREE_ON_GROUP_KEY".into());
            }
        } else {
            public_package_bytes = Some(response.public_key_package);
        }
        let response = client
            .sign_round1(SignRound1Request {
                session_id: request.request_id.clone(),
                participant_id: participant_id.clone(),
                message: message.clone(),
                key_id: request.key_id.clone(),
                request_id: request.request_id.clone(),
                policy_authorization: policy_authorization.clone(),
            })
            .await?
            .into_inner();
        if !response.ok {
            return Err("PARTICIPANT_COMMITMENT_REJECTED".into());
        }
        let identifier = participant_identifier(participant_id)?;
        commitments.insert(identifier, response.commitment);
    }
    if commitments.len() < request.threshold {
        return Err("SIGNING_THRESHOLD_NOT_MET".into());
    }
    let commitment_wire: Vec<SignerCommitment> = participants
        .iter()
        .map(|participant_id| {
            let identifier = participant_identifier(participant_id)?;
            let commitment = commitments
                .get(&identifier)
                .ok_or("SIGNER_COMMITMENT_MISSING")?;
            Ok(SignerCommitment {
                participant_id: participant_id.clone(),
                commitment: commitment.clone(),
            })
        })
        .collect::<Result<_, Box<dyn std::error::Error>>>()?;

    let mut shares = BTreeMap::new();
    for (participant_id, client) in &mut clients {
        let policy_authorization = request
            .policy_authorizations
            .get(participant_id)
            .ok_or("PARTICIPANT_POLICY_TOKEN_REQUIRED")?;
        let response = client
            .sign_round2(SignRound2Request {
                session_id: request.request_id.clone(),
                participant_id: participant_id.clone(),
                key_id: request.key_id.clone(),
                request_id: request.request_id.clone(),
                message: message.clone(),
                policy_authorization: policy_authorization.clone(),
                commitments: commitment_wire.clone(),
            })
            .await?
            .into_inner();
        if !response.ok {
            return Err("PARTICIPANT_SIGNATURE_SHARE_REJECTED".into());
        }
        shares.insert(
            participant_identifier(participant_id)?,
            frost::round2::SignatureShare::deserialize(&response.signature_share)?,
        );
    }
    let public_bytes = public_package_bytes.ok_or("PUBLIC_KEY_PACKAGE_MISSING")?;
    let public = frost::keys::PublicKeyPackage::deserialize(&public_bytes)?;
    let decoded_commitments = commitments
        .iter()
        .map(|(identifier, bytes)| {
            Ok((
                *identifier,
                frost::round1::SigningCommitments::deserialize(bytes)?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, frost::Error>>()?;
    let package = frost::SigningPackage::new(decoded_commitments, &message);
    let signature = frost::aggregate(&package, &shares, &public)?;
    public.verifying_key().verify(&message, &signature)?;
    let output = SignResponse {
        request_id: request.request_id,
        key_id: request.key_id,
        transaction_message_hash: hex::encode(Sha256::digest(&message)),
        signature_hex: hex::encode(signature.serialize()?),
        group_public_key_hex: hex::encode(public.verifying_key().serialize()?),
        verified: true,
        participants,
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

fn participant_identifier(
    participant_id: &str,
) -> Result<frost::Identifier, Box<dyn std::error::Error>> {
    let index = participant_id
        .strip_prefix('p')
        .ok_or("INVALID_PARTICIPANT_ID")?
        .parse::<u16>()?;
    if index == 0 {
        return Err("INVALID_PARTICIPANT_ID".into());
    }
    Ok(index.try_into()?)
}
