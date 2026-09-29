//! Authenticated, coordinator-bypassing transport for directed DKG packages.
//!
//! Peer TLS trusts a participant-specific CA certificate whose SHA-256 is
//! pinned by local configuration. Incoming client leaf certificates are
//! separately pinned to participant IDs. No coordinator certificate is
//! accepted on this service.

use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tonic::service::Interceptor;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity};
use tonic::{Request, Response, Status};

use crate::mpc_proto::participant_peer_client::ParticipantPeerClient;
use crate::mpc_proto::participant_peer_server::ParticipantPeer;
use crate::mpc_proto::{
    DeliverDkgRound1Request, DeliverDkgRound1Response, DeliverDkgRound2Request,
    DeliverDkgRound2Response, DkgTranscriptEntry, PublishDkgFinalizationRequest,
    PublishDkgFinalizationResponse, PublishDkgTranscriptRequest, PublishDkgTranscriptResponse,
};

const MAX_PACKAGE_BYTES: usize = 4096;
const MAX_PENDING_PACKAGES: usize = 256;

#[derive(Clone, Debug, Deserialize)]
struct PeerEndpoint {
    endpoint: String,
    server_name: String,
    ca_pem_path: String,
    ca_sha256: String,
}

#[derive(Clone, Debug)]
pub struct PeerTransport {
    local_id: String,
    own_identity: Identity,
    endpoints: HashMap<String, PeerEndpoint>,
}

impl PeerTransport {
    pub fn from_env(local_id: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let cert = fs::read(std::env::var("MPC_SERVER_CERT_PEM")?)?;
        let key = fs::read(std::env::var("MPC_SERVER_KEY_PEM")?)?;
        let raw = std::env::var("MPC_PEER_ENDPOINTS_JSON")?;
        let endpoints: HashMap<String, PeerEndpoint> = serde_json::from_str(&raw)?;
        if endpoints.is_empty() || endpoints.contains_key(local_id) {
            return Err("MPC_PEER_ENDPOINTS_JSON must contain other participants only".into());
        }
        let mut ca_pins = std::collections::HashSet::new();
        for (peer_id, peer) in &endpoints {
            validate_participant_id(peer_id)?;
            let uri: http::Uri = peer.endpoint.parse()?;
            if uri.scheme_str() != Some("https")
                || peer.server_name.is_empty()
                || peer.ca_sha256.len() != 64
            {
                return Err(format!("invalid peer transport configuration: {peer_id}").into());
            }
            let ca = fs::read(&peer.ca_pem_path)?;
            let digest = hex::encode(Sha256::digest(&ca));
            if !digest.eq_ignore_ascii_case(&peer.ca_sha256) {
                return Err(format!("peer CA pin mismatch: {peer_id}").into());
            }
            if !ca_pins.insert(digest) {
                return Err("each participant must use a distinct pinned CA".into());
            }
        }
        Ok(Self {
            local_id: local_id.to_string(),
            own_identity: Identity::from_pem(cert, key),
            endpoints,
        })
    }

    pub async fn deliver_dkg_round2(
        &self,
        target_id: &str,
        session_id: &str,
        package: Vec<u8>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let target = self
            .endpoints
            .get(target_id)
            .ok_or("target is not in the pinned participant roster")?;
        if session_id.is_empty()
            || session_id.len() > 128
            || package.is_empty()
            || package.len() > MAX_PACKAGE_BYTES
        {
            return Err("invalid directed DKG package".into());
        }
        let digest = hex::encode(Sha256::digest(&package));
        let message_id = dkg_message_id(session_id, &self.local_id, &digest);
        let ca_pem = fs::read(&target.ca_pem_path)?;
        let tls = ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(ca_pem))
            .identity(self.own_identity.clone())
            .domain_name(target.server_name.clone());
        let channel = tonic::transport::Endpoint::from_shared(target.endpoint.clone())?
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(10))
            .tls_config(tls)?
            .connect()
            .await?;
        let mut client = ParticipantPeerClient::new(channel);
        let result = client
            .deliver_dkg_round2(DeliverDkgRound2Request {
                session_id: session_id.to_string(),
                sender_id: self.local_id.clone(),
                recipient_id: target_id.to_string(),
                message_id,
                package,
            })
            .await?
            .into_inner();
        if !result.accepted || result.digest != digest {
            return Err("peer did not acknowledge the expected DKG package".into());
        }
        Ok(digest)
    }

    pub async fn broadcast_dkg_round1(
        &self,
        session_id: &str,
        package: Vec<u8>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        validate_payload(session_id, &package)?;
        let digest = hex::encode(Sha256::digest(&package));
        for target_id in self.endpoints.keys() {
            let (mut client, _) = self.client(target_id).await?;
            let response = client
                .deliver_dkg_round1(DeliverDkgRound1Request {
                    session_id: session_id.to_string(),
                    sender_id: self.local_id.clone(),
                    recipient_id: target_id.clone(),
                    package: package.clone(),
                })
                .await?
                .into_inner();
            if !response.accepted || response.package_hash != digest {
                return Err(
                    format!("peer {target_id} rejected the expected round-one package").into(),
                );
            }
        }
        Ok(digest)
    }

    pub async fn publish_dkg_transcript(
        &self,
        session_id: &str,
        threshold: u16,
        total: u16,
        entries: Vec<(String, String)>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let transcript_hash = dkg_transcript_hash(session_id, threshold, total, &entries)?;
        for target_id in self.endpoints.keys() {
            let (mut client, _) = self.client(target_id).await?;
            let response = client
                .publish_dkg_transcript(PublishDkgTranscriptRequest {
                    session_id: session_id.to_string(),
                    sender_id: self.local_id.clone(),
                    threshold: u32::from(threshold),
                    total_participants: u32::from(total),
                    entries: entries
                        .iter()
                        .map(|(participant_id, round1_package_hash)| DkgTranscriptEntry {
                            participant_id: participant_id.clone(),
                            round1_package_hash: round1_package_hash.clone(),
                        })
                        .collect(),
                    transcript_hash: transcript_hash.clone(),
                })
                .await?
                .into_inner();
            if !response.accepted || response.transcript_hash != transcript_hash {
                return Err(format!("peer {target_id} rejected the DKG transcript").into());
            }
        }
        Ok(transcript_hash)
    }

    pub async fn publish_dkg_finalization(
        &self,
        session_id: &str,
        transcript_hash: &str,
        public_key_package_hash: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        for target_id in self.endpoints.keys() {
            let (mut client, _) = self.client(target_id).await?;
            let response = client
                .publish_dkg_finalization(PublishDkgFinalizationRequest {
                    session_id: session_id.to_string(),
                    sender_id: self.local_id.clone(),
                    transcript_hash: transcript_hash.to_string(),
                    public_key_package_hash: public_key_package_hash.to_string(),
                })
                .await?
                .into_inner();
            if !response.accepted {
                return Err(format!("peer {target_id} rejected DKG finalization").into());
            }
        }
        Ok(())
    }

    async fn client(
        &self,
        target_id: &str,
    ) -> Result<
        (ParticipantPeerClient<Channel>, &PeerEndpoint),
        Box<dyn std::error::Error + Send + Sync>,
    > {
        let target = self
            .endpoints
            .get(target_id)
            .ok_or("target is not in the pinned participant roster")?;
        let ca_pem = fs::read(&target.ca_pem_path)?;
        let tls = ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(ca_pem))
            .identity(self.own_identity.clone())
            .domain_name(target.server_name.clone());
        let channel = tonic::transport::Endpoint::from_shared(target.endpoint.clone())?
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(10))
            .tls_config(tls)?
            .connect()
            .await?;
        Ok((ParticipantPeerClient::new(channel), target))
    }

    pub fn peer_ids(&self) -> std::collections::HashSet<String> {
        self.endpoints.keys().cloned().collect()
    }
}

#[derive(Clone, Debug)]
pub struct PeerMailbox {
    local_id: String,
    pins: HashMap<String, [u8; 32]>,
    entries: Arc<Mutex<HashMap<(String, String), (String, Vec<u8>)>>>,
    round1: Arc<Mutex<HashMap<(String, String), (String, Vec<u8>)>>>,
    transcripts: Arc<Mutex<HashMap<(String, String), String>>>,
    finalizations: Arc<Mutex<HashMap<(String, String), (String, String)>>>,
}

impl PeerMailbox {
    pub fn from_env(local_id: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let raw = std::env::var("MPC_PEER_CERT_PINS_JSON")?;
        let values: HashMap<String, String> = serde_json::from_str(&raw)?;
        let mut pins = HashMap::new();
        for (participant_id, value) in values {
            validate_participant_id(&participant_id)?;
            if participant_id == local_id || value.len() != 64 {
                return Err("invalid participant certificate pin roster".into());
            }
            let mut pin = [0u8; 32];
            hex::decode_to_slice(value, &mut pin)?;
            pins.insert(participant_id, pin);
        }
        if pins.is_empty() {
            return Err("MPC_PEER_CERT_PINS_JSON must pin peer client certificates".into());
        }
        let unique_pins: std::collections::HashSet<[u8; 32]> = pins.values().copied().collect();
        if unique_pins.len() != pins.len() {
            return Err("participant certificate pins must be unique".into());
        }
        Ok(Self {
            local_id: local_id.to_string(),
            pins,
            entries: Arc::new(Mutex::new(HashMap::new())),
            round1: Arc::new(Mutex::new(HashMap::new())),
            transcripts: Arc::new(Mutex::new(HashMap::new())),
            finalizations: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn tls_interceptor(&self) -> PeerCertificatePin {
        PeerCertificatePin {
            pins: self.pins.clone(),
        }
    }

    pub fn peer_ids(&self) -> std::collections::HashSet<String> {
        self.pins.keys().cloned().collect()
    }

    pub fn store_local_dkg_round1(
        &self,
        session_id: &str,
        package: Vec<u8>,
    ) -> Result<String, String> {
        validate_payload(session_id, &package).map_err(|error| error.to_string())?;
        let digest = hex::encode(Sha256::digest(&package));
        let key = (session_id.to_string(), self.local_id.clone());
        let mut round1 = self
            .round1
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        if let Some((previous, _)) = round1.get(&key) {
            if previous != &digest {
                return Err("DKG_LOCAL_ROUND1_EQUIVOCATION".to_string());
            }
        } else {
            if round1.len() >= MAX_PENDING_PACKAGES {
                return Err("PEER_MAILBOX_FULL".to_string());
            }
            round1.insert(key, (digest.clone(), package));
        }
        Ok(digest)
    }

    pub fn local_dkg_transcript(
        &self,
        session_id: &str,
        threshold: u16,
        total: u16,
    ) -> Result<Vec<(String, String)>, String> {
        let round1 = self
            .round1
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        let mut entries = Vec::with_capacity(total as usize);
        for index in 1..=total {
            let participant_id = format!("p{index}");
            let value = round1
                .get(&(session_id.to_string(), participant_id.clone()))
                .ok_or_else(|| "DKG_ROUND1_ROSTER_INCOMPLETE".to_string())?;
            entries.push((participant_id, value.0.clone()));
        }
        dkg_transcript_hash(session_id, threshold, total, &entries)
            .map_err(|error| error.to_string())?;
        Ok(entries)
    }

    pub fn local_dkg_packages(
        &self,
        session_id: &str,
        total: u16,
    ) -> Result<Vec<(u16, Vec<u8>)>, String> {
        let round1 = self
            .round1
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        let mut packages = Vec::with_capacity(total.saturating_sub(1) as usize);
        for index in 1..=total {
            let participant_id = format!("p{index}");
            if participant_id == self.local_id {
                continue;
            }
            let (_, bytes) = round1
                .get(&(session_id.to_string(), participant_id))
                .ok_or_else(|| "DKG_ROUND1_ROSTER_INCOMPLETE".to_string())?;
            packages.push((index, bytes.clone()));
        }
        Ok(packages)
    }

    pub fn record_local_transcript(
        &self,
        session_id: &str,
        transcript_hash: &str,
    ) -> Result<(), String> {
        let key = (session_id.to_string(), self.local_id.clone());
        let mut transcripts = self
            .transcripts
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        if let Some(previous) = transcripts.get(&key) {
            if previous != transcript_hash {
                return Err("DKG_LOCAL_TRANSCRIPT_EQUIVOCATION".to_string());
            }
        } else {
            if transcripts.len() >= MAX_PENDING_PACKAGES {
                return Err("PEER_MAILBOX_FULL".to_string());
            }
            transcripts.insert(key, transcript_hash.to_string());
        }
        Ok(())
    }

    pub fn round2_packages_for_roster(
        &self,
        session_id: &str,
        total: u16,
    ) -> Result<Vec<(u16, Vec<u8>)>, String> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        let mut keys = Vec::with_capacity(total.saturating_sub(1) as usize);
        for index in 1..=total {
            let participant_id = format!("p{index}");
            if participant_id == self.local_id {
                continue;
            }
            let key = (session_id.to_string(), participant_id.clone());
            if !entries.contains_key(&key) {
                return Err("DKG_ROUND2_ROSTER_INCOMPLETE".to_string());
            }
            keys.push((index, key));
        }
        Ok(keys
            .into_iter()
            .map(|(index, key)| (index, entries.get(&key).expect("checked above").1.clone()))
            .collect())
    }

    pub fn clear_completed_dkg_session(&self, session_id: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?
            .retain(|(session, _), _| session != session_id);
        self.round1
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?
            .retain(|(session, _), _| session != session_id);
        self.transcripts
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?
            .retain(|(session, _), _| session != session_id);
        self.finalizations
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?
            .retain(|(session, _), _| session != session_id);
        Ok(())
    }

    pub fn transcript_consensus(
        &self,
        session_id: &str,
        transcript_hash: &str,
        total: u16,
    ) -> Result<(), String> {
        let transcripts = self
            .transcripts
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        for index in 1..=total {
            let participant = format!("p{index}");
            let key = (session_id.to_string(), participant);
            if transcripts.get(&key).map(String::as_str) != Some(transcript_hash) {
                return Err("DKG_TRANSCRIPT_ALL_PARTICIPANTS_MUST_AGREE".to_string());
            }
        }
        Ok(())
    }

    pub fn record_local_finalization(
        &self,
        session_id: &str,
        transcript_hash: &str,
        public_key_package_hash: &str,
    ) -> Result<(), String> {
        self.record_finalization(
            &self.local_id,
            session_id,
            transcript_hash,
            public_key_package_hash,
        )
        .map(|_| ())
    }

    pub fn finalization_consensus(
        &self,
        session_id: &str,
        transcript_hash: &str,
        public_key_package_hash: &str,
        total: u16,
    ) -> Result<(), String> {
        let finalizations = self
            .finalizations
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        for index in 1..=total {
            let participant = format!("p{index}");
            let key = (session_id.to_string(), participant);
            let expected = (
                transcript_hash.to_string(),
                public_key_package_hash.to_string(),
            );
            if finalizations.get(&key) != Some(&expected) {
                return Err("DKG_FINALIZATION_ALL_PARTICIPANTS_MUST_AGREE".to_string());
            }
        }
        Ok(())
    }

    fn record_finalization(
        &self,
        sender_id: &str,
        session_id: &str,
        transcript_hash: &str,
        public_key_package_hash: &str,
    ) -> Result<u32, String> {
        let key = (session_id.to_string(), sender_id.to_string());
        let mut finalizations = self
            .finalizations
            .lock()
            .map_err(|_| "PEER_MAILBOX_LOCK_FAILED".to_string())?;
        let value = (
            transcript_hash.to_string(),
            public_key_package_hash.to_string(),
        );
        if let Some(previous) = finalizations.get(&key) {
            if previous != &value {
                return Err("DKG_FINALIZATION_EQUIVOCATION".to_string());
            }
        } else {
            if finalizations.len() >= MAX_PENDING_PACKAGES {
                return Err("PEER_MAILBOX_FULL".to_string());
            }
            finalizations.insert(key, value.clone());
        }
        Ok(finalizations
            .iter()
            .filter(|((session, _), observed)| session == session_id && *observed == &value)
            .count() as u32)
    }
}

#[derive(Clone)]
pub struct PeerCertificatePin {
    pins: HashMap<String, [u8; 32]>,
}

#[derive(Clone, Debug)]
pub struct AuthenticatedPeer(pub String);

impl Interceptor for PeerCertificatePin {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        let certs = request
            .peer_certs()
            .ok_or_else(|| Status::unauthenticated("MUTUAL_TLS_CLIENT_CERT_REQUIRED"))?;
        let cert = certs
            .first()
            .ok_or_else(|| Status::unauthenticated("MUTUAL_TLS_CLIENT_CERT_REQUIRED"))?;
        let digest: [u8; 32] = Sha256::digest(cert.as_ref()).into();
        let participant_id = self
            .pins
            .iter()
            .find_map(|(id, pin)| (*pin == digest).then(|| id.clone()))
            .ok_or_else(|| Status::permission_denied("UNPINNED_PARTICIPANT_CERTIFICATE"))?;
        request
            .extensions_mut()
            .insert(AuthenticatedPeer(participant_id));
        Ok(request)
    }
}

#[tonic::async_trait]
impl ParticipantPeer for PeerMailbox {
    async fn deliver_dkg_round1(
        &self,
        request: Request<DeliverDkgRound1Request>,
    ) -> Result<Response<DeliverDkgRound1Response>, Status> {
        let authenticated = request
            .extensions()
            .get::<AuthenticatedPeer>()
            .ok_or_else(|| Status::unauthenticated("PEER_IDENTITY_REQUIRED"))?
            .0
            .clone();
        let request = request.into_inner();
        if request.sender_id != authenticated || request.recipient_id != self.local_id {
            return Err(Status::permission_denied(
                "PEER_IDENTITY_OR_RECIPIENT_MISMATCH",
            ));
        }
        validate_participant_id(&request.sender_id)
            .map_err(|_| Status::invalid_argument("INVALID_SENDER_ID"))?;
        validate_payload(&request.session_id, &request.package)
            .map_err(|_| Status::invalid_argument("INVALID_DKG_PACKAGE"))?;
        let digest = hex::encode(Sha256::digest(&request.package));
        let key = (request.session_id, request.sender_id);
        let mut round1 = self
            .round1
            .lock()
            .map_err(|_| Status::internal("PEER_MAILBOX_LOCK_FAILED"))?;
        if let Some((previous, _)) = round1.get(&key) {
            if previous != &digest {
                return Err(Status::already_exists("DKG_ROUND1_EQUIVOCATION"));
            }
        } else {
            if round1.len() >= MAX_PENDING_PACKAGES {
                return Err(Status::resource_exhausted("PEER_MAILBOX_FULL"));
            }
            round1.insert(key, (digest.clone(), request.package));
        }
        Ok(Response::new(DeliverDkgRound1Response {
            accepted: true,
            package_hash: digest,
        }))
    }

    async fn deliver_dkg_round2(
        &self,
        request: Request<DeliverDkgRound2Request>,
    ) -> Result<Response<DeliverDkgRound2Response>, Status> {
        let authenticated = request
            .extensions()
            .get::<AuthenticatedPeer>()
            .ok_or_else(|| Status::unauthenticated("PEER_IDENTITY_REQUIRED"))?
            .0
            .clone();
        let request = request.into_inner();
        validate_participant_id(&request.sender_id)
            .map_err(|_| Status::invalid_argument("INVALID_SENDER_ID"))?;
        if request.sender_id != authenticated || request.recipient_id != self.local_id {
            return Err(Status::permission_denied(
                "PEER_IDENTITY_OR_RECIPIENT_MISMATCH",
            ));
        }
        if request.session_id.is_empty()
            || request.session_id.len() > 128
            || request.package.is_empty()
            || request.package.len() > MAX_PACKAGE_BYTES
        {
            return Err(Status::invalid_argument("INVALID_DKG_PACKAGE"));
        }
        let digest = hex::encode(Sha256::digest(&request.package));
        if request.message_id != dkg_message_id(&request.session_id, &request.sender_id, &digest) {
            return Err(Status::invalid_argument("DKG_MESSAGE_ID_MISMATCH"));
        }
        let key = (request.session_id, request.sender_id);
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| Status::internal("PEER_MAILBOX_LOCK_FAILED"))?;
        if let Some((previous_digest, _)) = entries.get(&key) {
            if previous_digest != &digest {
                return Err(Status::already_exists("DKG_PACKAGE_EQUIVOCATION"));
            }
        } else {
            if entries.len() >= MAX_PENDING_PACKAGES {
                return Err(Status::resource_exhausted("PEER_MAILBOX_FULL"));
            }
            entries.insert(key, (digest.clone(), request.package));
        }
        Ok(Response::new(DeliverDkgRound2Response {
            accepted: true,
            digest,
        }))
    }

    async fn publish_dkg_transcript(
        &self,
        request: Request<PublishDkgTranscriptRequest>,
    ) -> Result<Response<PublishDkgTranscriptResponse>, Status> {
        let authenticated = request
            .extensions()
            .get::<AuthenticatedPeer>()
            .ok_or_else(|| Status::unauthenticated("PEER_IDENTITY_REQUIRED"))?
            .0
            .clone();
        let request = request.into_inner();
        if request.sender_id != authenticated {
            return Err(Status::permission_denied("PEER_IDENTITY_MISMATCH"));
        }
        let threshold = u16::try_from(request.threshold)
            .map_err(|_| Status::invalid_argument("INVALID_DKG_THRESHOLD"))?;
        let total = u16::try_from(request.total_participants)
            .map_err(|_| Status::invalid_argument("INVALID_DKG_ROSTER"))?;
        let entries: Vec<_> = request
            .entries
            .into_iter()
            .map(|entry| (entry.participant_id, entry.round1_package_hash))
            .collect();
        let expected_hash = dkg_transcript_hash(&request.session_id, threshold, total, &entries)
            .map_err(|_| Status::invalid_argument("INVALID_DKG_TRANSCRIPT"))?;
        if expected_hash != request.transcript_hash {
            return Err(Status::invalid_argument("DKG_TRANSCRIPT_HASH_MISMATCH"));
        }

        let round1 = self
            .round1
            .lock()
            .map_err(|_| Status::internal("PEER_MAILBOX_LOCK_FAILED"))?;
        for (participant_id, package_hash) in &entries {
            let observed = round1
                .get(&(request.session_id.clone(), participant_id.clone()))
                .ok_or_else(|| Status::failed_precondition("DKG_ROUND1_ROSTER_INCOMPLETE"))?;
            if &observed.0 != package_hash {
                return Err(Status::failed_precondition(
                    "DKG_TRANSCRIPT_PACKAGE_MISMATCH",
                ));
            }
        }
        drop(round1);
        let key = (request.session_id.clone(), authenticated);
        let mut transcripts = self
            .transcripts
            .lock()
            .map_err(|_| Status::internal("PEER_MAILBOX_LOCK_FAILED"))?;
        if let Some(previous) = transcripts.get(&key) {
            if previous != &expected_hash {
                return Err(Status::already_exists("DKG_TRANSCRIPT_EQUIVOCATION"));
            }
        } else {
            if transcripts.len() >= MAX_PENDING_PACKAGES {
                return Err(Status::resource_exhausted("PEER_MAILBOX_FULL"));
            }
            transcripts.insert(key, expected_hash.clone());
        }
        let matching = transcripts
            .iter()
            .filter(|((session, _), hash)| {
                session == &request.session_id && *hash == &expected_hash
            })
            .count() as u32;
        Ok(Response::new(PublishDkgTranscriptResponse {
            accepted: true,
            transcript_hash: expected_hash,
            matching_participants: matching,
        }))
    }

    async fn publish_dkg_finalization(
        &self,
        request: Request<PublishDkgFinalizationRequest>,
    ) -> Result<Response<PublishDkgFinalizationResponse>, Status> {
        let authenticated = request
            .extensions()
            .get::<AuthenticatedPeer>()
            .ok_or_else(|| Status::unauthenticated("PEER_IDENTITY_REQUIRED"))?
            .0
            .clone();
        let request = request.into_inner();
        if request.sender_id != authenticated {
            return Err(Status::permission_denied("PEER_IDENTITY_MISMATCH"));
        }
        if request.session_id.is_empty()
            || request.session_id.len() > 128
            || !is_sha256(&request.transcript_hash)
            || !is_sha256(&request.public_key_package_hash)
        {
            return Err(Status::invalid_argument("INVALID_DKG_FINALIZATION"));
        }
        let transcript_key = (request.session_id.clone(), request.sender_id.clone());
        let transcripts = self
            .transcripts
            .lock()
            .map_err(|_| Status::internal("PEER_MAILBOX_LOCK_FAILED"))?;
        if transcripts.get(&transcript_key) != Some(&request.transcript_hash) {
            return Err(Status::failed_precondition(
                "DKG_SENDER_TRANSCRIPT_NOT_VERIFIED",
            ));
        }
        drop(transcripts);
        let matching = self
            .record_finalization(
                &request.sender_id,
                &request.session_id,
                &request.transcript_hash,
                &request.public_key_package_hash,
            )
            .map_err(|_| Status::already_exists("DKG_FINALIZATION_EQUIVOCATION"))?;
        Ok(Response::new(PublishDkgFinalizationResponse {
            accepted: true,
            matching_participants: matching,
        }))
    }
}

fn dkg_message_id(session_id: &str, sender_id: &str, digest: &str) -> String {
    hex::encode(Sha256::digest(
        format!("dflow-dkg-round2-v1\0{session_id}\0{sender_id}\0{digest}").as_bytes(),
    ))
}

pub fn dkg_transcript_hash(
    session_id: &str,
    threshold: u16,
    total: u16,
    entries: &[(String, String)],
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if validate_session_id(session_id).is_err()
        || threshold < 2
        || threshold > total
        || total > 16
        || entries.len() != total as usize
    {
        return Err("invalid DKG transcript parameters".into());
    }
    let mut canonical = entries.to_vec();
    canonical.sort_by(|a, b| a.0.cmp(&b.0));
    for (position, (participant_id, digest)) in canonical.iter().enumerate() {
        validate_participant_id(participant_id).map_err(|error| error.to_string())?;
        if participant_id != &format!("p{}", position + 1)
            || digest.len() != 64
            || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("DKG transcript roster or digest invalid".into());
        }
    }
    let mut transcript =
        format!("dflow-frost-dkg-transcript-v1\0{session_id}\0{threshold}\0{total}\0");
    for (participant_id, digest) in canonical {
        transcript.push_str(&participant_id);
        transcript.push('\0');
        transcript.push_str(&digest.to_ascii_lowercase());
        transcript.push('\0');
    }
    Ok(hex::encode(Sha256::digest(transcript.as_bytes())))
}

fn validate_payload(
    session_id: &str,
    package: &[u8],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if validate_session_id(session_id).is_err()
        || package.is_empty()
        || package.len() > MAX_PACKAGE_BYTES
    {
        return Err("invalid DKG session or package".into());
    }
    Ok(())
}

fn validate_session_id(value: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !(16..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("session ID must be 16-128 ASCII letters, digits, '-' or '_'".into());
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_participant_id(value: &str) -> Result<(), Box<dyn std::error::Error>> {
    let suffix = value.strip_prefix('p').ok_or("participant ID must be pN")?;
    let index = suffix.parse::<u16>()?;
    if index == 0 || format!("p{index}") != value {
        return Err("participant ID must be canonical pN".into());
    }
    Ok(())
}
