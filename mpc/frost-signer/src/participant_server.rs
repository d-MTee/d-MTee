use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default)]
pub struct ParticipantServerState {
    pub participant_id: String,
    pub host: String,
    pub port: u16,
    pub threshold: u16,
    pub total_participants: u16,
    pub ready: bool,
    pub sessions: HashMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct ParticipantServer {
    pub state: Arc<Mutex<ParticipantServerState>>,
}

impl ParticipantServer {
    pub fn new(participant_id: &str, host: &str, port: u16, threshold: u16, total_participants: u16) -> Self {
        Self {
            state: Arc::new(Mutex::new(ParticipantServerState {
                participant_id: participant_id.to_string(),
                host: host.to_string(),
                port,
                threshold,
                total_participants,
                ready: true,
                sessions: HashMap::new(),
            })),
        }
    }

    pub fn register_session(&self, session_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "mutex lock failed".to_string())?;
        state.sessions.insert(session_id.to_string(), "REGISTERED".to_string());
        Ok(())
    }

    pub fn session_status(&self) -> String {
        let state = self.state.lock().unwrap();
        format!(
            "participant={} host={} port={} ready={} sessions={}",
            state.participant_id,
            state.host,
            state.port,
            state.ready,
            state.sessions.len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participant_server_registers_session() {
        let server = ParticipantServer::new("p1", "127.0.0.1", 9001, 2, 3);
        server.register_session("sess-1").unwrap();

        let state = server.state.lock().unwrap();
        assert!(state.sessions.contains_key("sess-1"));
    }
}
