//! Cryptographic state machine for one independently operated FROST participant.
//!
//! Secrets and signing nonces are retained only in this process. They are never
//! accepted as RPC inputs or returned by these methods. Production deployment
//! must run one instance per trust domain and provide authenticated, confidential
//! peer transport for directed DKG round-two messages.

use std::collections::{BTreeMap, HashMap};

use frost_ed25519 as frost;
use rand::rngs::OsRng;

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

struct DkgState {
    threshold: u16,
    total: u16,
    round1_secret: Option<frost::keys::dkg::round1::SecretPackage>,
    round2_secret: Option<frost::keys::dkg::round2::SecretPackage>,
    round1_packages: BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package>,
}

struct SigningState {
    key_id: String,
    message: Vec<u8>,
    nonce: Option<frost::round1::SigningNonces>,
}

pub struct ParticipantRuntime {
    pub config: ParticipantConfig,
    pub state: SessionState,
    dkg_sessions: HashMap<String, DkgState>,
    signing_sessions: HashMap<String, SigningState>,
    key_packages: HashMap<String, frost::keys::KeyPackage>,
    public_packages: HashMap<String, frost::keys::PublicKeyPackage>,
}

impl ParticipantRuntime {
    pub fn new(config: ParticipantConfig) -> Self {
        Self {
            config,
            state: SessionState::default(),
            dkg_sessions: HashMap::new(),
            signing_sessions: HashMap::new(),
            key_packages: HashMap::new(),
            public_packages: HashMap::new(),
        }
    }

    fn local_identifier(&self) -> Result<frost::Identifier, String> {
        let suffix = self
            .config
            .participant_id
            .strip_prefix('p')
            .ok_or_else(|| "PARTICIPANT_ID_MUST_BE_PN".to_string())?;
        let index = suffix
            .parse::<u16>()
            .map_err(|_| "PARTICIPANT_ID_MUST_BE_PN".to_string())?;
        if index == 0 || format!("p{index}") != self.config.participant_id {
            return Err("PARTICIPANT_ID_MUST_BE_PN".to_string());
        }
        index
            .try_into()
            .map_err(|_| "INVALID_PARTICIPANT_ID".to_string())
    }

    fn identifier(index: u16, total: u16) -> Result<frost::Identifier, String> {
        if index == 0 || index > total {
            return Err("PARTICIPANT_INDEX_OUT_OF_RANGE".to_string());
        }
        index
            .try_into()
            .map_err(|_| "INVALID_PARTICIPANT_ID".to_string())
    }

    /// Generates a FROST DKG round-one package and retains its secret locally.
    pub fn dkg_round1(
        &mut self,
        session_id: &str,
        threshold: u16,
        total: u16,
    ) -> Result<Vec<u8>, String> {
        if session_id.is_empty() || session_id.len() > 128 {
            return Err("INVALID_SESSION_ID".to_string());
        }
        if threshold < 2 || threshold > total || total > 16 {
            return Err("INVALID_DKG_PARAMETERS".to_string());
        }
        let identifier = self.local_identifier()?;
        if identifier.serialize().is_empty() {
            return Err("INVALID_PARTICIPANT_ID".to_string());
        }
        if self.dkg_sessions.contains_key(session_id) || self.key_packages.contains_key(session_id)
        {
            return Err("DKG_SESSION_ALREADY_EXISTS".to_string());
        }
        let mut rng = OsRng;
        let (secret, package) = frost::keys::dkg::part1(identifier, total, threshold, &mut rng)
            .map_err(|error| format!("DKG_ROUND1_FAILED:{error}"))?;
        let public_bytes = package
            .serialize()
            .map_err(|error| format!("DKG_PACKAGE_SERIALIZE_FAILED:{error}"))?;
        self.dkg_sessions.insert(
            session_id.to_string(),
            DkgState {
                threshold,
                total,
                round1_secret: Some(secret),
                round2_secret: None,
                round1_packages: BTreeMap::new(),
            },
        );
        self.state = SessionState {
            session_id: session_id.to_string(),
            phase: "DKG_ROUND1".to_string(),
            dkg_round_1_done: true,
            ..SessionState::default()
        };
        Ok(public_bytes)
    }

    /// Consumes the local round-one secret and returns directed round-two
    /// packages. Each `(recipient index, bytes)` package must travel only to
    /// that recipient over an authenticated confidential peer channel.
    pub fn dkg_round2(
        &mut self,
        session_id: &str,
        packages: Vec<(u16, Vec<u8>)>,
    ) -> Result<Vec<(u16, Vec<u8>)>, String> {
        let local_id = self.local_identifier()?;
        let dkg = self
            .dkg_sessions
            .get_mut(session_id)
            .ok_or_else(|| "DKG_SESSION_NOT_FOUND".to_string())?;
        if dkg.round2_secret.is_some() {
            return Err("DKG_ROUND2_ALREADY_COMPLETED".to_string());
        }
        if packages.len() != dkg.total.saturating_sub(1) as usize {
            return Err("DKG_ROUND1_ROSTER_INCOMPLETE".to_string());
        }
        let mut round1 = BTreeMap::new();
        for (index, bytes) in packages {
            let id = Self::identifier(index, dkg.total)?;
            let package = frost::keys::dkg::round1::Package::deserialize(&bytes)
                .map_err(|error| format!("DKG_ROUND1_PACKAGE_INVALID:{error}"))?;
            if round1.insert(id, package).is_some() {
                return Err("DUPLICATE_DKG_PARTICIPANT".to_string());
            }
        }
        if round1.contains_key(&local_id) {
            return Err("LOCAL_DKG_PACKAGE_MUST_NOT_BE_REPLAYED".to_string());
        }
        let secret = dkg
            .round1_secret
            .take()
            .ok_or_else(|| "DKG_ROUND1_SECRET_MISSING".to_string())?;
        let (round2_secret, recipient_packages) = frost::keys::dkg::part2(secret, &round1)
            .map_err(|error| format!("DKG_ROUND2_FAILED:{error}"))?;
        let mut output = Vec::with_capacity(recipient_packages.len());
        for (recipient, package) in recipient_packages {
            let index = (1..=dkg.total)
                .find(|index| {
                    Self::identifier(*index, dkg.total)
                        .is_ok_and(|candidate| candidate == recipient)
                })
                .ok_or_else(|| "UNKNOWN_DKG_RECIPIENT".to_string())?;
            output.push((
                index,
                package
                    .serialize()
                    .map_err(|error| format!("DKG_ROUND2_PACKAGE_SERIALIZE_FAILED:{error}"))?,
            ));
        }
        dkg.round2_secret = Some(round2_secret);
        dkg.round1_packages = round1;
        self.state.phase = "DKG_ROUND2".to_string();
        self.state.dkg_round_2_done = true;
        Ok(output)
    }

    /// Finalizes DKG from the packages addressed to this participant. The key
    /// share is retained in memory and never returned from the participant.
    pub fn dkg_finalize(
        &mut self,
        session_id: &str,
        recipient_packages: Vec<(u16, Vec<u8>)>,
    ) -> Result<Vec<u8>, String> {
        let local_id = self.local_identifier()?;
        let dkg = self
            .dkg_sessions
            .remove(session_id)
            .ok_or_else(|| "DKG_SESSION_NOT_FOUND".to_string())?;
        if recipient_packages.len() != dkg.total.saturating_sub(1) as usize {
            return Err("DKG_ROUND2_ROSTER_INCOMPLETE".to_string());
        }
        let mut round2 = BTreeMap::new();
        for (index, bytes) in recipient_packages {
            let id = Self::identifier(index, dkg.total)?;
            let package = frost::keys::dkg::round2::Package::deserialize(&bytes)
                .map_err(|error| format!("DKG_ROUND2_PACKAGE_INVALID:{error}"))?;
            if round2.insert(id, package).is_some() {
                return Err("DUPLICATE_DKG_PARTICIPANT".to_string());
            }
        }
        if round2.contains_key(&local_id) {
            return Err("LOCAL_DKG_PACKAGE_MUST_NOT_BE_REPLAYED".to_string());
        }
        let secret = dkg
            .round2_secret
            .ok_or_else(|| "DKG_ROUND2_SECRET_MISSING".to_string())?;
        let (key_package, public_package) =
            frost::keys::dkg::part3(&secret, &dkg.round1_packages, &round2)
                .map_err(|error| format!("DKG_FINALIZE_FAILED:{error}"))?;
        if key_package.identifier() != &local_id {
            return Err("DKG_LOCAL_IDENTIFIER_MISMATCH".to_string());
        }
        let public_bytes = public_package
            .serialize()
            .map_err(|error| format!("PUBLIC_KEY_PACKAGE_SERIALIZE_FAILED:{error}"))?;
        if self
            .key_packages
            .insert(session_id.to_string(), key_package)
            .is_some()
        {
            return Err("KEY_EPOCH_ALREADY_EXISTS".to_string());
        }
        self.public_packages
            .insert(session_id.to_string(), public_package);
        self.state.phase = "DKG_COMPLETE".to_string();
        self.state.ready = true;
        Ok(public_bytes)
    }

    /// Produces a single-use FROST commitment and retains the nonce internally.
    pub fn sign_round1(
        &mut self,
        session_id: &str,
        key_id: &str,
        message: &[u8],
    ) -> Result<Vec<u8>, String> {
        if session_id.is_empty()
            || session_id.len() > 128
            || message.is_empty()
            || message.len() > 1232
        {
            return Err("INVALID_SIGNING_REQUEST".to_string());
        }
        if self.signing_sessions.contains_key(session_id) {
            return Err("SIGNING_SESSION_ALREADY_EXISTS".to_string());
        }
        let key = self
            .key_packages
            .get(key_id)
            .ok_or_else(|| "KEY_EPOCH_NOT_FOUND".to_string())?;
        let mut rng = OsRng;
        let (nonce, commitment) = frost::round1::commit(key.signing_share(), &mut rng);
        let commitment_bytes = commitment
            .serialize()
            .map_err(|error| format!("SIGNING_COMMITMENT_SERIALIZE_FAILED:{error}"))?;
        self.signing_sessions.insert(
            session_id.to_string(),
            SigningState {
                key_id: key_id.to_string(),
                message: message.to_vec(),
                nonce: Some(nonce),
            },
        );
        self.state = SessionState {
            session_id: session_id.to_string(),
            phase: "SIGN_ROUND1".to_string(),
            message: message.to_vec(),
            signing_round_1_done: true,
            ..SessionState::default()
        };
        Ok(commitment_bytes)
    }

    /// Creates a FROST signature share using only this participant's local key
    /// package and locally held nonce. Private key/nonce RPC parameters are not accepted.
    pub fn sign_round2(
        &mut self,
        session_id: &str,
        message: &[u8],
        commitments: Vec<(u16, Vec<u8>)>,
    ) -> Result<Vec<u8>, String> {
        let local_id = self.local_identifier()?;
        let total = self.config.total_participants;
        let threshold = self.config.threshold;
        let signing = self
            .signing_sessions
            .get_mut(session_id)
            .ok_or_else(|| "SIGNING_SESSION_NOT_FOUND".to_string())?;
        if signing.message != message {
            return Err("SIGNING_MESSAGE_MISMATCH".to_string());
        }
        let mut commitment_map = BTreeMap::new();
        for (index, bytes) in commitments {
            let id = Self::identifier(index, total)?;
            let commitment = frost::round1::SigningCommitments::deserialize(&bytes)
                .map_err(|error| format!("SIGNING_COMMITMENT_INVALID:{error}"))?;
            if commitment_map.insert(id, commitment).is_some() {
                return Err("DUPLICATE_SIGNER".to_string());
            }
        }
        if commitment_map.len() < threshold as usize {
            return Err("SIGNING_THRESHOLD_NOT_MET".to_string());
        }
        if !commitment_map.contains_key(&local_id) {
            return Err("LOCAL_COMMITMENT_MISSING".to_string());
        }
        let package = frost::SigningPackage::new(commitment_map, message);
        let nonce = signing
            .nonce
            .take()
            .ok_or_else(|| "SIGNING_NONCE_ALREADY_USED".to_string())?;
        let key = self
            .key_packages
            .get(&signing.key_id)
            .ok_or_else(|| "KEY_EPOCH_NOT_FOUND".to_string())?;
        let share = frost::round2::sign(&package, &nonce, key)
            .map_err(|error| format!("SIGNATURE_SHARE_FAILED:{error}"))?;
        self.signing_sessions.remove(session_id);
        self.state.phase = "SIGN_ROUND2".to_string();
        self.state.signing_round_2_done = true;
        Ok(share.serialize())
    }

    /// Aggregates and verifies shares against this participant's DKG public package.
    pub fn aggregate(
        &self,
        key_id: &str,
        message: &[u8],
        commitments: Vec<(u16, Vec<u8>)>,
        shares: Vec<(u16, Vec<u8>)>,
    ) -> Result<Vec<u8>, String> {
        let total = self.config.total_participants;
        let mut commitment_map = BTreeMap::new();
        for (index, bytes) in commitments {
            let id = Self::identifier(index, total)?;
            let commitment = frost::round1::SigningCommitments::deserialize(&bytes)
                .map_err(|error| format!("SIGNING_COMMITMENT_INVALID:{error}"))?;
            if commitment_map.insert(id, commitment).is_some() {
                return Err("DUPLICATE_SIGNER".to_string());
            }
        }
        let mut share_map = BTreeMap::new();
        for (index, bytes) in shares {
            let id = Self::identifier(index, total)?;
            let share = frost::round2::SignatureShare::deserialize(&bytes)
                .map_err(|error| format!("SIGNATURE_SHARE_INVALID:{error}"))?;
            if share_map.insert(id, share).is_some() {
                return Err("DUPLICATE_SIGNATURE_SHARE".to_string());
            }
        }
        if share_map.len() < self.config.threshold as usize
            || share_map.keys().any(|id| !commitment_map.contains_key(id))
        {
            return Err("SIGNING_THRESHOLD_NOT_MET".to_string());
        }
        let public = self
            .public_packages
            .get(key_id)
            .ok_or_else(|| "KEY_EPOCH_NOT_FOUND".to_string())?;
        let package = frost::SigningPackage::new(commitment_map, message);
        let signature = frost::aggregate(&package, &share_map, public)
            .map_err(|error| format!("SIGNATURE_AGGREGATION_FAILED:{error}"))?;
        public
            .verifying_key()
            .verify(message, &signature)
            .map_err(|error| format!("AGGREGATE_SIGNATURE_INVALID:{error}"))?;
        signature
            .serialize()
            .map_err(|error| format!("SIGNATURE_SERIALIZE_FAILED:{error}"))
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
            key_store_path: String::new(),
        });

        assert_eq!(runtime.config.participant_id, "p1");
        assert_eq!(runtime.state.phase, "");
    }
}
