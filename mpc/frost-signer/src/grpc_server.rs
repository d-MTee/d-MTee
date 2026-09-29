use std::fs;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tonic::service::Interceptor;
use tonic::transport::{Certificate, Identity, ServerTlsConfig};
use tonic::{Request, Response, Status};

use crate::key_store::KmsEncryptedKeyStore;
use crate::mpc_proto::participant_peer_server::ParticipantPeerServer;
use crate::mpc_proto::participant_signer_server::{ParticipantSigner, ParticipantSignerServer};
use crate::mpc_proto::{
    CreateSigningSessionRequest, CreateSigningSessionResponse, DkgFinalizeRequest,
    DkgFinalizeResponse, DkgRound1Request, DkgRound1Response, DkgRound2Request, DkgRound2Response,
    FinalizeSessionRequest, FinalizeSessionResponse, GetSessionStatusRequest,
    GetSessionStatusResponse, RegisterParticipantRequest, RegisterParticipantResponse,
    SignRound1Request, SignRound1Response, SignRound2Request, SignRound2Response,
};
use crate::participant_runtime::{ParticipantConfig, ParticipantRuntime};
use crate::peer_transport::{dkg_transcript_hash, PeerMailbox, PeerTransport};

#[derive(Clone)]
pub struct GrpcServer {
    pub participant_id: String,
    threshold: u16,
    total_participants: u16,
    runtime: Arc<Mutex<ParticipantRuntime>>,
    peer_transport: PeerTransport,
    peer_mailbox: PeerMailbox,
    key_store: KmsEncryptedKeyStore,
}

impl GrpcServer {
    pub fn new(
        participant_id: &str,
        threshold: u16,
        total_participants: u16,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if threshold < 2 || threshold > total_participants || total_participants > 16 {
            return Err("invalid threshold participant configuration".into());
        }
        let peer_mailbox = PeerMailbox::from_env(participant_id)?;
        let peer_transport = PeerTransport::from_env(participant_id)?;
        if peer_mailbox.peer_ids() != peer_transport.peer_ids()
            || peer_transport.peer_ids().len() != total_participants.saturating_sub(1) as usize
            || peer_transport.peer_ids()
                != (1..=total_participants)
                    .filter(|index| format!("p{index}") != participant_id)
                    .map(|index| format!("p{index}"))
                    .collect()
        {
            return Err(
                "peer endpoint and certificate-pin roster must match total_participants".into(),
            );
        }
        let key_store = KmsEncryptedKeyStore::from_env(participant_id)?;
        let mut runtime = ParticipantRuntime::new(ParticipantConfig {
            participant_id: participant_id.to_string(),
            threshold,
            total_participants,
            ..ParticipantConfig::default()
        });
        if let Some(epoch) = key_store.load_active()? {
            runtime
                .restore_key_epoch(
                    &epoch.key_id,
                    epoch.threshold,
                    epoch.total_participants,
                    &epoch.transcript_hash,
                    epoch.private_package,
                    epoch.public_package,
                )
                .map_err(|_| "ACTIVE_KEY_EPOCH_RESTORE_FAILED")?;
        }
        Ok(Self {
            participant_id: participant_id.to_string(),
            threshold,
            total_participants,
            runtime: Arc::new(Mutex::new(runtime)),
            peer_transport,
            peer_mailbox,
            key_store,
        })
    }

    pub async fn serve(self, addr: std::net::SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
        let cert_path = std::env::var("MPC_SERVER_CERT_PEM")?;
        let key_path = std::env::var("MPC_SERVER_KEY_PEM")?;
        let ca_path = std::env::var("MPC_CLIENT_CA_PEM")?;
        let identity = Identity::from_pem(fs::read(cert_path)?, fs::read(key_path)?);
        let client_ca = Certificate::from_pem(fs::read(ca_path)?);
        let auth = CoordinatorCertificatePin::from_env()?;
        let tls = ServerTlsConfig::new()
            .identity(identity)
            .client_ca_root(client_ca);
        tonic::transport::Server::builder()
            .tls_config(tls)?
            .add_service(ParticipantSignerServer::with_interceptor(
                self.clone(),
                auth,
            ))
            .add_service(ParticipantPeerServer::with_interceptor(
                self.peer_mailbox.clone(),
                self.peer_mailbox.tls_interceptor(),
            ))
            .serve(addr)
            .await?;
        Ok(())
    }

    fn check_participant(&self, participant_id: &str) -> Result<(), Status> {
        if participant_id != self.participant_id {
            return Err(Status::permission_denied("PARTICIPANT_ID_MISMATCH"));
        }
        Ok(())
    }
}

#[derive(Clone)]
struct CoordinatorCertificatePin([u8; 32]);

impl CoordinatorCertificatePin {
    fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let value = std::env::var("MPC_COORDINATOR_CERT_SHA256")?;
        if value.len() != 64 {
            return Err("MPC_COORDINATOR_CERT_SHA256 must be 64 hex characters".into());
        }
        let mut pin = [0u8; 32];
        hex::decode_to_slice(value, &mut pin)?;
        Ok(Self(pin))
    }
}

impl Interceptor for CoordinatorCertificatePin {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        let certificates = request
            .peer_certs()
            .ok_or_else(|| Status::unauthenticated("MUTUAL_TLS_CLIENT_CERT_REQUIRED"))?;
        let certificate = certificates
            .first()
            .ok_or_else(|| Status::unauthenticated("MUTUAL_TLS_CLIENT_CERT_REQUIRED"))?;
        let digest: [u8; 32] = Sha256::digest(certificate.as_ref()).into();
        if digest != self.0 {
            return Err(Status::permission_denied(
                "COORDINATOR_CERTIFICATE_PIN_MISMATCH",
            ));
        }
        Ok(request)
    }
}

#[tonic::async_trait]
impl ParticipantSigner for GrpcServer {
    async fn register_participant(
        &self,
        request: Request<RegisterParticipantRequest>,
    ) -> Result<Response<RegisterParticipantResponse>, Status> {
        let _ = request;
        Err(Status::unimplemented("REGISTRATION_NOT_CONFIGURED"))
    }

    async fn create_signing_session(
        &self,
        request: Request<CreateSigningSessionRequest>,
    ) -> Result<Response<CreateSigningSessionResponse>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_SIGNING_NOT_CONFIGURED"))
    }

    async fn dkg_round1(
        &self,
        request: Request<DkgRound1Request>,
    ) -> Result<Response<DkgRound1Response>, Status> {
        let request = request.into_inner();
        self.check_participant(&request.participant_id)?;
        if !(16..=128).contains(&request.session_id.len())
            || !request
                .session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            || !(16..=128).contains(&request.request_id.len())
            || !request
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            || request.threshold != u32::from(self.threshold)
            || request.total_participants != u32::from(self.total_participants)
        {
            return Err(Status::invalid_argument("INVALID_DKG_REQUEST"));
        }
        let package = self
            .runtime
            .lock()
            .await
            .dkg_round1(
                &request.session_id,
                &request.request_id,
                self.threshold,
                self.total_participants,
            )
            .map_err(|_| Status::failed_precondition("DKG_ROUND1_FAILED"))?;
        let package_hash = self
            .peer_mailbox
            .store_local_dkg_round1(&request.session_id, package.clone())
            .map_err(|_| Status::failed_precondition("DKG_LOCAL_ROUND1_PACKAGE_CONFLICT"))?;
        self.peer_transport
            .broadcast_dkg_round1(&request.session_id, package.clone())
            .await
            .map_err(|_| Status::unavailable("DKG_ROUND1_PEER_DELIVERY_FAILED"))?;
        Ok(Response::new(DkgRound1Response {
            ok: true,
            session_id: request.session_id,
            participant_id: self.participant_id.clone(),
            round1_package: package,
            package_hash,
        }))
    }

    async fn dkg_round2(
        &self,
        request: Request<DkgRound2Request>,
    ) -> Result<Response<DkgRound2Response>, Status> {
        let request = request.into_inner();
        self.check_participant(&request.participant_id)?;
        if let Some(transcript_hash) = self
            .runtime
            .lock()
            .await
            .key_transcript_hash(&request.session_id)
            .map(str::to_string)
        {
            return Ok(Response::new(DkgRound2Response {
                ok: true,
                session_id: request.session_id,
                participant_id: self.participant_id.clone(),
                status: "DKG_ALREADY_COMPLETE".to_string(),
                transcript_hash,
                delivered_packages: 0,
            }));
        }
        let entries = self
            .peer_mailbox
            .local_dkg_transcript(&request.session_id, self.threshold, self.total_participants)
            .map_err(|_| Status::failed_precondition("DKG_ROUND1_ROSTER_INCOMPLETE"))?;
        let transcript_hash = dkg_transcript_hash(
            &request.session_id,
            self.threshold,
            self.total_participants,
            &entries,
        )
        .map_err(|_| Status::invalid_argument("INVALID_DKG_TRANSCRIPT"))?;
        self.peer_mailbox
            .record_local_transcript(&request.session_id, &transcript_hash)
            .map_err(|_| Status::failed_precondition("DKG_LOCAL_TRANSCRIPT_CONFLICT"))?;
        self.peer_transport
            .publish_dkg_transcript(
                &request.session_id,
                self.threshold,
                self.total_participants,
                entries,
            )
            .await
            .map_err(|_| Status::unavailable("DKG_TRANSCRIPT_PEER_DELIVERY_FAILED"))?;
        if self
            .peer_mailbox
            .transcript_consensus(
                &request.session_id,
                &transcript_hash,
                self.total_participants,
            )
            .is_err()
        {
            return Ok(Response::new(DkgRound2Response {
                ok: false,
                session_id: request.session_id,
                participant_id: self.participant_id.clone(),
                status: "DKG_TRANSCRIPT_ALL_PARTICIPANTS_PENDING".to_string(),
                transcript_hash,
                delivered_packages: 0,
            }));
        }
        let round1_packages = self
            .peer_mailbox
            .local_dkg_packages(&request.session_id, self.total_participants)
            .map_err(|_| Status::failed_precondition("DKG_ROUND1_ROSTER_INCOMPLETE"))?;
        let packages = self
            .runtime
            .lock()
            .await
            .dkg_round2(&request.session_id, round1_packages)
            .map_err(|_| Status::failed_precondition("DKG_ROUND2_FAILED"))?;
        let mut delivered = 0u32;
        for (recipient, package) in packages {
            let target_id = format!("p{recipient}");
            self.peer_transport
                .deliver_dkg_round2(&target_id, &request.session_id, package)
                .await
                .map_err(|_| Status::unavailable("DKG_ROUND2_PRIVATE_DELIVERY_FAILED"))?;
            delivered += 1;
        }
        Ok(Response::new(DkgRound2Response {
            ok: true,
            session_id: request.session_id,
            participant_id: self.participant_id.clone(),
            status: "DKG_ROUND2_DELIVERED".to_string(),
            transcript_hash,
            delivered_packages: delivered,
        }))
    }

    async fn dkg_finalize(
        &self,
        request: Request<DkgFinalizeRequest>,
    ) -> Result<Response<DkgFinalizeResponse>, Status> {
        let request = request.into_inner();
        self.check_participant(&request.participant_id)?;
        let completed = {
            let runtime = self.runtime.lock().await;
            if runtime.key_epoch_ready(&request.session_id) {
                runtime
                    .public_key_package_bytes(&request.session_id)
                    .map(|package| {
                        let hash = hex::encode(Sha256::digest(&package));
                        (package, hash)
                    })
            } else {
                None
            }
        };
        if let Some((public_key_package, public_key_hash)) = completed {
            return Ok(Response::new(DkgFinalizeResponse {
                ok: true,
                session_id: request.session_id,
                participant_id: self.participant_id.clone(),
                public_key_package,
                public_key_hash,
                status: "DKG_COMPLETE".to_string(),
            }));
        }
        let entries = self
            .peer_mailbox
            .local_dkg_transcript(&request.session_id, self.threshold, self.total_participants)
            .map_err(|_| Status::failed_precondition("DKG_ROUND1_ROSTER_INCOMPLETE"))?;
        let transcript_hash = dkg_transcript_hash(
            &request.session_id,
            self.threshold,
            self.total_participants,
            &entries,
        )
        .map_err(|_| Status::invalid_argument("INVALID_DKG_TRANSCRIPT"))?;
        self.peer_mailbox
            .transcript_consensus(
                &request.session_id,
                &transcript_hash,
                self.total_participants,
            )
            .map_err(|_| {
                Status::failed_precondition("DKG_TRANSCRIPT_ALL_PARTICIPANTS_NOT_AGREED")
            })?;
        let cached_public_package = self
            .runtime
            .lock()
            .await
            .public_key_package_bytes(&request.session_id);
        let public_key_package = if let Some(package) = cached_public_package {
            package
        } else {
            let round2_packages = self
                .peer_mailbox
                .round2_packages_for_roster(&request.session_id, self.total_participants)
                .map_err(|_| Status::failed_precondition("DKG_ROUND2_ROSTER_INCOMPLETE"))?;
            self.runtime
                .lock()
                .await
                .dkg_finalize(&request.session_id, round2_packages)
                .map_err(|_| Status::failed_precondition("DKG_FINALIZE_FAILED"))?
        };
        let public_key_hash = hex::encode(Sha256::digest(&public_key_package));
        let private_key_package = self
            .runtime
            .lock()
            .await
            .private_key_package_bytes(&request.session_id)
            .map_err(|_| Status::failed_precondition("PRIVATE_KEY_PACKAGE_UNAVAILABLE"))?;
        self.key_store
            .save_pending(
                &request.session_id,
                self.threshold,
                self.total_participants,
                &transcript_hash,
                private_key_package,
                &public_key_package,
            )
            .map_err(|_| Status::unavailable("KEY_EPOCH_ENCRYPTED_PERSISTENCE_FAILED"))?;
        self.peer_mailbox
            .record_local_finalization(&request.session_id, &transcript_hash, &public_key_hash)
            .map_err(|_| Status::failed_precondition("DKG_FINALIZATION_CONFLICT"))?;
        self.peer_transport
            .publish_dkg_finalization(&request.session_id, &transcript_hash, &public_key_hash)
            .await
            .map_err(|_| Status::unavailable("DKG_FINALIZATION_PEER_DELIVERY_FAILED"))?;
        if self
            .peer_mailbox
            .finalization_consensus(
                &request.session_id,
                &transcript_hash,
                &public_key_hash,
                self.total_participants,
            )
            .is_err()
        {
            return Ok(Response::new(DkgFinalizeResponse {
                ok: false,
                session_id: request.session_id,
                participant_id: self.participant_id.clone(),
                public_key_package,
                public_key_hash,
                status: "DKG_FINALIZATION_ALL_PARTICIPANTS_PENDING".to_string(),
            }));
        }
        self.key_store
            .activate(&request.session_id, &transcript_hash)
            .map_err(|_| Status::unavailable("KEY_EPOCH_PERSISTENT_ACTIVATION_FAILED"))?;
        self.runtime
            .lock()
            .await
            .activate_key_epoch(&request.session_id, &transcript_hash)
            .map_err(|_| Status::failed_precondition("KEY_EPOCH_ACTIVATION_FAILED"))?;
        self.peer_mailbox
            .clear_completed_dkg_session(&request.session_id)
            .map_err(|_| Status::internal("PEER_MAILBOX_LOCK_FAILED"))?;
        Ok(Response::new(DkgFinalizeResponse {
            ok: true,
            session_id: request.session_id,
            participant_id: self.participant_id.clone(),
            public_key_package,
            public_key_hash,
            status: "DKG_COMPLETE".to_string(),
        }))
    }

    async fn sign_round1(
        &self,
        request: Request<SignRound1Request>,
    ) -> Result<Response<SignRound1Response>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_SIGNING_NOT_CONFIGURED"))
    }

    async fn sign_round2(
        &self,
        request: Request<SignRound2Request>,
    ) -> Result<Response<SignRound2Response>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_SIGNING_NOT_CONFIGURED"))
    }

    async fn get_session_status(
        &self,
        request: Request<GetSessionStatusRequest>,
    ) -> Result<Response<GetSessionStatusResponse>, Status> {
        let _ = request;
        Err(Status::unimplemented("SESSION_STATUS_NOT_CONFIGURED"))
    }

    async fn finalize_session(
        &self,
        request: Request<FinalizeSessionRequest>,
    ) -> Result<Response<FinalizeSessionResponse>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_SIGNING_NOT_CONFIGURED"))
    }
}
