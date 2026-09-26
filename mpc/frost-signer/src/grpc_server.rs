use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tonic::{Request, Response, Status};

use crate::mpc_proto::mpc::v1::participant_signer_server::ParticipantSigner;
use crate::mpc_proto::mpc::v1::{
    CreateSigningSessionRequest, CreateSigningSessionResponse, DkgRound1Request, DkgRound1Response,
    DkgRound2Request, DkgRound2Response, FinalizeSessionRequest, FinalizeSessionResponse,
    GetSessionStatusRequest, GetSessionStatusResponse, RegisterParticipantRequest,
    RegisterParticipantResponse, SignRound1Request, SignRound1Response, SignRound2Request,
    SignRound2Response,
};

#[derive(Clone, Debug, Default)]
pub struct GrpcSessionState {
    pub session_id: String,
    pub phase: String,
    pub ready: bool,
}

#[derive(Clone, Debug, Default)]
pub struct GrpcServer {
    pub participant_id: String,
    pub host: String,
    pub port: u16,
    pub sessions: Arc<Mutex<HashMap<String, GrpcSessionState>>>,
}

impl GrpcServer {
    pub fn new(participant_id: &str, host: &str, port: u16) -> Self {
        Self {
            participant_id: participant_id.to_string(),
            host: host.to_string(),
            port,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "session map lock failed".to_string())?;
        sessions.insert(
            session_id.to_string(),
            GrpcSessionState {
                session_id: session_id.to_string(),
                phase: "REGISTERED".to_string(),
                ready: false,
            },
        );
        Ok(())
    }

    pub fn update_phase(&self, session_id: &str, phase: &str, ready: bool) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "session map lock failed".to_string())?;
        if let Some(state) = sessions.get_mut(session_id) {
            state.phase = phase.to_string();
            state.ready = ready;
            return Ok(());
        }
        Err(format!("session not found: {session_id}"))
    }

    pub fn status(&self) -> String {
        let sessions = self.sessions.lock().unwrap();
        format!(
            "participant={} host={} port={} sessions={}",
            self.participant_id,
            self.host,
            self.port,
            sessions.len()
        )
    }
}

#[tonic::async_trait]
impl ParticipantSigner for GrpcServer {
    async fn register_participant(
        &self,
        request: Request<RegisterParticipantRequest>,
    ) -> Result<Response<RegisterParticipantResponse>, Status> {
        let request = request.into_inner();
        let session_id = format!("session-{}", request.participant_id);
        let _ = self.register_session(&session_id);
        Ok(Response::new(RegisterParticipantResponse {
            ok: true,
            status: format!("registered:{}", request.participant_id),
        }))
    }

    async fn create_signing_session(
        &self,
        request: Request<CreateSigningSessionRequest>,
    ) -> Result<Response<CreateSigningSessionResponse>, Status> {
        let request = request.into_inner();
        self.register_session(&request.session_id)
            .map_err(|err| Status::internal(err))?;
        Ok(Response::new(CreateSigningSessionResponse {
            ok: true,
            session_id: request.session_id,
            status: "created".to_string(),
        }))
    }

    async fn dkg_round_1(
        &self,
        request: Request<DkgRound1Request>,
    ) -> Result<Response<DkgRound1Response>, Status> {
        let request = request.into_inner();
        self.update_phase(&request.session_id, "DKG_ROUND_1", false)
            .map_err(|err| Status::not_found(err))?;
        Ok(Response::new(DkgRound1Response {
            ok: true,
            session_id: request.session_id,
            participant_id: request.participant_id,
            round1_package: vec![],
            recipient_packages: vec![],
        }))
    }

    async fn dkg_round_2(
        &self,
        request: Request<DkgRound2Request>,
    ) -> Result<Response<DkgRound2Response>, Status> {
        let request = request.into_inner();
        self.update_phase(&request.session_id, "DKG_ROUND_2", false)
            .map_err(|err| Status::not_found(err))?;
        Ok(Response::new(DkgRound2Response {
            ok: true,
            session_id: request.session_id,
            participant_id: request.participant_id,
            round2_package: vec![],
            signing_key_package: vec![],
        }))
    }

    async fn sign_round_1(
        &self,
        request: Request<SignRound1Request>,
    ) -> Result<Response<SignRound1Response>, Status> {
        let request = request.into_inner();
        self.update_phase(&request.session_id, "SIGN_ROUND_1", false)
            .map_err(|err| Status::not_found(err))?;
        Ok(Response::new(SignRound1Response {
            ok: true,
            session_id: request.session_id,
            participant_id: request.participant_id,
            nonce: vec![],
            commitment: vec![],
        }))
    }

    async fn sign_round_2(
        &self,
        request: Request<SignRound2Request>,
    ) -> Result<Response<SignRound2Response>, Status> {
        let request = request.into_inner();
        self.update_phase(&request.session_id, "SIGN_ROUND_2", true)
            .map_err(|err| Status::not_found(err))?;
        Ok(Response::new(SignRound2Response {
            ok: true,
            session_id: request.session_id,
            participant_id: request.participant_id,
            signature_share: vec![],
        }))
    }

    async fn get_session_status(
        &self,
        request: Request<GetSessionStatusRequest>,
    ) -> Result<Response<GetSessionStatusResponse>, Status> {
        let request = request.into_inner();
        let sessions = self.sessions.lock().unwrap();
        let state = sessions.get(&request.session_id).cloned().unwrap_or_default();
        Ok(Response::new(GetSessionStatusResponse {
            session_id: request.session_id,
            phase: state.phase,
            ready: state.ready,
            completed_participants: vec![],
            error: String::new(),
        }))
    }

    async fn finalize_session(
        &self,
        request: Request<FinalizeSessionRequest>,
    ) -> Result<Response<FinalizeSessionResponse>, Status> {
        let request = request.into_inner();
        Ok(Response::new(FinalizeSessionResponse {
            ok: true,
            session_id: request.session_id,
            signature_hex: "stub-signature".to_string(),
            verified: true,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grpc_server_registers_session() {
        let server = GrpcServer::new("p1", "127.0.0.1", 9001);
        server.register_session("sess-1").unwrap();
        server.update_phase("sess-1", "READY", true).unwrap();

        let sessions = server.sessions.lock().unwrap();
        let state = sessions.get("sess-1").unwrap();
        assert_eq!(state.phase, "READY");
        assert!(state.ready);
    }
}
