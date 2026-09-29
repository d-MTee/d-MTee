# Production gaps after v4

## Implemented in code
- [x] Real RFC 9591 FROST Ed25519 threshold signing
- [x] Real 2-of-3 DKG using Zcash Foundation `frost-ed25519`
- [x] Real signature-share aggregation and group-key verification
- [x] Nitro Enclave signer source
- [x] Nitro NSM attestation document generation
- [x] VSock parent/enclave communication path
- [x] Nitro COSE signature, pinned root, freshness, PCR3/PCR4/PCR8 and challenge verification
- [x] KMS recipient-decrypt path for a persistent encrypted 32-byte enclave signing seed
- [x] Bearer authorization for administrative and signing routes
- [x] Role-based API credentials with participant-scoped signer identities and hash-only secret registry
- [x] DKG and FROST signing gRPC methods run participant-local protocol rounds; coordinator aggregates and verifies the final group signature
- [x] mTLS gRPC listener requires client CA validation and a pinned coordinator certificate
- [x] Participant-specific peer client certificate pins and per-peer CA pins for direct DKG transport
- [x] DKG transcript replay/equivocation rejection and all-participant public-key package agreement
- [x] Participant-scoped KMS encryption, atomic active-epoch selection, recovery validation, and epoch rotation through a fresh DKG
- [x] Participant-side Ed25519 policy-token verification and durable one-use policy-nonce claims before FROST commitments
- [x] `/sign/mpc` coordinates signer-specific policy tokens, collects FROST shares over mTLS, verifies the group key equals the approved wallet, and attaches the signature to the approved Solana transaction
- [x] Participant-local FROST DKG/signing state machine keeps secret packages and nonces out of RPC inputs
- [x] Approval-to-request binding and one-use request/nonces
- [x] Atomic SHA-256 hash-linked audit stream and verification endpoint
- [x] Provider, signing-policy, and send-outcome metric instrumentation

The KMS broker must be installed as a managed parent-host service and the KMS
key policy must be applied to measured PCRs before enclave signing can start.

## Requires deployment / external security work
- [ ] Deploy and independently validate direct peer DKG across three separate trust domains
- [ ] Deploy separate durable nonce volumes and policy-authority key configuration on every participant; validate concurrent replay rejection and disaster recovery on target hosts
- [ ] Run and independently review encrypted FROST-share persistence, recovery, rotation, and rollback using each participant's production KMS key
- [x] Automate KMS seed provisioning, participant-scoped ciphertext storage, and broker deployment
- [ ] Run and independently review KMS bootstrap, rotation, rollback, and recovery on a real Nitro host
- [ ] Provision separate KMS keys/roles and IAM encryption-context restrictions for each FROST participant; validate the Python AWS SDK helper in the deployed image
- [ ] External independent cryptographic/security audit of this application's integration
- [ ] Deploy and independently verify the full DKG → FROST signing → transaction assembly → devnet submission flow across three separate hosts before setting `ENABLE_DISTRIBUTED_FROST_MAINNET=true`
- [ ] Venue-specific production execution adapters and transaction reconciliation/retry state machine
- [ ] Full transaction reconciliation / retry state machine
- [ ] Geyser/direct pool state ingestion for every supported DEX

These are deployment/security assurance tasks, not placeholders pretending to be cryptography.
