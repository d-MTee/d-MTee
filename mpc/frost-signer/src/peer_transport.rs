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
use tonic::transport::{Certificate, ClientTlsConfig, Identity};
use tonic::{Request, Response, Status};

use crate::mpc_proto::participant_peer_client::ParticipantPeerClient;
use crate::mpc_proto::participant_peer_server::ParticipantPeer;
use crate::mpc_proto::{DeliverDkgRound2Request, DeliverDkgRound2Response};

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

    pub fn peer_ids(&self) -> std::collections::HashSet<String> {
        self.endpoints.keys().cloned().collect()
    }
}

#[derive(Clone, Debug)]
pub struct PeerMailbox {
    local_id: String,
    pins: HashMap<String, [u8; 32]>,
    entries: Arc<Mutex<HashMap<(String, String), (String, Vec<u8>)>>>,
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
        })
    }

    pub fn tls_interceptor(&self) -> PeerCertificatePin {
        PeerCertificatePin {
            pins: self.pins.clone(),
        }
    }

    /// Read a package once its round handler is ready to consume it.
    pub fn take_round2_packages(&self, session_id: &str) -> Vec<(String, Vec<u8>)> {
        let Ok(mut entries) = self.entries.lock() else {
            return Vec::new();
        };
        let keys: Vec<_> = entries
            .keys()
            .filter(|(session, _)| session == session_id)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| entries.remove(&key).map(|(_, package)| (key.1, package)))
            .collect()
    }

    pub fn peer_ids(&self) -> std::collections::HashSet<String> {
        self.pins.keys().cloned().collect()
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
}

fn dkg_message_id(session_id: &str, sender_id: &str, digest: &str) -> String {
    hex::encode(Sha256::digest(
        format!("dflow-dkg-round2-v1\0{session_id}\0{sender_id}\0{digest}").as_bytes(),
    ))
}

fn validate_participant_id(value: &str) -> Result<(), Box<dyn std::error::Error>> {
    let suffix = value.strip_prefix('p').ok_or("participant ID must be pN")?;
    let index = suffix.parse::<u16>()?;
    if index == 0 || format!("p{index}") != value {
        return Err("participant ID must be canonical pN".into());
    }
    Ok(())
}
