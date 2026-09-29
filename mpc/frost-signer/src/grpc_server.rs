use std::fs;

use sha2::{Digest, Sha256};
use tonic::service::Interceptor;
use tonic::transport::{Certificate, Identity, ServerTlsConfig};
use tonic::{Request, Response, Status};

use crate::mpc_proto::participant_peer_server::ParticipantPeerServer;
use crate::mpc_proto::participant_signer_server::{ParticipantSigner, ParticipantSignerServer};
use crate::mpc_proto::{
    CreateSigningSessionRequest, CreateSigningSessionResponse, DkgRound1Request, DkgRound1Response,
    DkgRound2Request, DkgRound2Response, FinalizeSessionRequest, FinalizeSessionResponse,
    GetSessionStatusRequest, GetSessionStatusResponse, RegisterParticipantRequest,
    RegisterParticipantResponse, SignRound1Request, SignRound1Response, SignRound2Request,
    SignRound2Response,
};
use crate::peer_transport::{PeerMailbox, PeerTransport};

#[derive(Clone, Debug, Default)]
pub struct GrpcServer {
    pub participant_id: String,
    pub host: String,
    pub port: u16,
}

impl GrpcServer {
    pub fn new(participant_id: &str, host: &str, port: u16) -> Self {
        Self {
            participant_id: participant_id.to_string(),
            host: host.to_string(),
            port,
        }
    }

    pub async fn serve(self, addr: std::net::SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
        let cert_path = std::env::var("MPC_SERVER_CERT_PEM")?;
        let key_path = std::env::var("MPC_SERVER_KEY_PEM")?;
        let ca_path = std::env::var("MPC_CLIENT_CA_PEM")?;
        let identity = Identity::from_pem(fs::read(cert_path)?, fs::read(key_path)?);
        let client_ca = Certificate::from_pem(fs::read(ca_path)?);
        let auth = CoordinatorCertificatePin::from_env()?;
        let peer_mailbox = PeerMailbox::from_env(&self.participant_id)?;
        let peer_transport = PeerTransport::from_env(&self.participant_id)?;
        if peer_mailbox.peer_ids() != peer_transport.peer_ids() {
            return Err("peer endpoint roster and certificate pin roster differ".into());
        }
        let tls = ServerTlsConfig::new()
            .identity(identity)
            .client_ca_root(client_ca);
        tonic::transport::Server::builder()
            .tls_config(tls)?
            .add_service(ParticipantSignerServer::with_interceptor(self, auth))
            .add_service(ParticipantPeerServer::with_interceptor(
                peer_mailbox.clone(),
                peer_mailbox.tls_interceptor(),
            ))
            .serve(addr)
            .await?;
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
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }

    async fn create_signing_session(
        &self,
        request: Request<CreateSigningSessionRequest>,
    ) -> Result<Response<CreateSigningSessionResponse>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }

    async fn dkg_round1(
        &self,
        request: Request<DkgRound1Request>,
    ) -> Result<Response<DkgRound1Response>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }

    async fn dkg_round2(
        &self,
        request: Request<DkgRound2Request>,
    ) -> Result<Response<DkgRound2Response>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }

    async fn sign_round1(
        &self,
        request: Request<SignRound1Request>,
    ) -> Result<Response<SignRound1Response>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }

    async fn sign_round2(
        &self,
        request: Request<SignRound2Request>,
    ) -> Result<Response<SignRound2Response>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }

    async fn get_session_status(
        &self,
        request: Request<GetSessionStatusRequest>,
    ) -> Result<Response<GetSessionStatusResponse>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }

    async fn finalize_session(
        &self,
        request: Request<FinalizeSessionRequest>,
    ) -> Result<Response<FinalizeSessionResponse>, Status> {
        let _ = request;
        Err(Status::unimplemented("DISTRIBUTED_FROST_NOT_IMPLEMENTED"))
    }
}
