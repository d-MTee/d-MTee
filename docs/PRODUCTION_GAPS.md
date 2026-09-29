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
- [x] DKG gRPC methods run the participant-local FROST ceremony; signing and aggregation RPCs fail closed
- [x] mTLS gRPC listener requires client CA validation and a pinned coordinator certificate
- [x] Participant-specific peer client certificate pins and per-peer CA pins for direct DKG transport
- [x] DKG transcript replay/equivocation rejection and all-participant public-key package agreement
- [x] Participant-local FROST DKG/signing state machine keeps secret packages and nonces out of RPC inputs
- [x] Approval-to-request binding and one-use request/nonces
- [x] Atomic SHA-256 hash-linked audit stream and verification endpoint
- [x] Provider, signing-policy, and send-outcome metric instrumentation

The KMS broker must be installed as a managed parent-host service and the KMS
key policy must be applied to measured PCRs before enclave signing can start.

## Requires deployment / external security work
- [ ] Deploy and independently validate direct peer DKG across three separate trust domains
- [ ] Independently verify policy authorization and replay state inside every signer participant
- [ ] Persist encrypted FROST shares with KMS/Nitro protection and implement recovery/rotation
- [x] Automate KMS seed provisioning, participant-scoped ciphertext storage, and broker deployment
- [ ] Run and independently review KMS bootstrap, rotation, rollback, and recovery on a real Nitro host
- [ ] External independent cryptographic/security audit of this application's integration
- [ ] Connect distributed FROST signing shares to transaction assembly; mainnet submission is hard-disabled until then
- [ ] Venue-specific production execution adapters and transaction reconciliation/retry state machine
- [ ] Full transaction reconciliation / retry state machine
- [ ] Geyser/direct pool state ingestion for every supported DEX

These are deployment/security assurance tasks, not placeholders pretending to be cryptography.
