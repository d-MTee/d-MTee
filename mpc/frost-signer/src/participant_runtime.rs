use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct ParticipantConfig {
    pub participant_id: String,
    pub host: String,
    pub port: u16,
    pub threshold: u16,
    pub total_participants: u16,
    pub key_store_path: String,
}

#[derive(Clone, Debug, Default)]
pub struct SessionState {
    pub session_id: String,
    pub phase: String,
    pub ready: bool,
    pub message: Vec<u8>,
    pub dkg_round_1_done: bool,
    pub dkg_round_2_done: bool,
    pub signing_round_1_done: bool,
    pub signing_round_2_done: bool,
}

#[derive(Clone, Debug, Default)]
pub struct DkgRound1Output {
    pub participant_id: String,
    pub round1_package: Vec<u8>,
    pub recipient_packages: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, Default)]
pub struct DkgRound2Input {
    pub participant_id: String,
    pub round1_secret: Vec<u8>,
    pub round1_packages: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, Default)]
pub struct SignRound1Output {
    pub participant_id: String,
    pub nonce: Vec<u8>,
    pub commitment: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct SignRound2Input {
    pub participant_id: String,
    pub signing_package: Vec<u8>,
    pub nonce: Vec<u8>,
    pub signing_key: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct ParticipantRuntime {
    pub config: ParticipantConfig,
    pub state: SessionState,
    pub local_key_store: BTreeMap<String, Vec<u8>>,
}

impl ParticipantRuntime {
    pub fn new(config: ParticipantConfig) -> Self {
        Self {
            config,
            state: SessionState::default(),
            local_key_store: BTreeMap::new(),
        }
    }

    pub fn register_session(&mut self, session_id: &str, message: &[u8]) {
        self.state.session_id = session_id.to_string();
        self.state.phase = "INIT".to_string();
        self.state.message = message.to_vec();
    }

    pub fn dkg_round_1(&mut self) -> Result<DkgRound1Output, String> {
        if self.state.session_id.is_empty() {
            return Err("session not initialized".to_string());
        }

        self.state.dkg_round_1_done = true;
        self.state.phase = "DKG".to_string();

        Ok(DkgRound1Output {
            participant_id: self.config.participant_id.clone(),
            round1_package: vec![],
            recipient_packages: vec![],
        })
    }

    pub fn dkg_round_2(&mut self, input: DkgRound2Input) -> Result<Vec<u8>, String> {
        let _ = input;
        self.state.dkg_round_2_done = true;
        self.state.ready = true;
        self.state.phase = "READY".to_string();
        Ok(vec![])
    }

    pub fn sign_round_1(&mut self) -> Result<SignRound1Output, String> {
        self.state.signing_round_1_done = true;
        self.state.phase = "SIGNING".to_string();

        Ok(SignRound1Output {
            participant_id: self.config.participant_id.clone(),
            nonce: vec![],
            commitment: vec![],
        })
    }

    pub fn sign_round_2(&mut self, input: SignRound2Input) -> Result<Vec<u8>, String> {
        let _ = input;
        self.state.signing_round_2_done = true;
        self.state.phase = "DONE".to_string();
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participant_runtime_starts_in_init_state() {
        let runtime = ParticipantRuntime::new(ParticipantConfig {
            participant_id: "p1".to_string(),
            host: "127.0.0.1".to_string(),
            port: 9001,
            threshold: 2,
            total_participants: 3,
            key_store_path: "/tmp/p1-key".to_string(),
        });

        assert_eq!(runtime.config.participant_id, "p1");
        assert_eq!(runtime.state.phase, "");
    }
}
