use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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
