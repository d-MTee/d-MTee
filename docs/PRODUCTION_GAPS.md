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
- [x] gRPC placeholder DKG/signing/finalize methods fail with UNIMPLEMENTED
- [x] Approval-to-request binding and one-use request/nonces
- [x] Atomic SHA-256 hash-linked audit stream and verification endpoint
- [x] Provider, signing-policy, and send-outcome metric instrumentation

The KMS broker must be installed as a managed parent-host service and the KMS
key policy must be applied to measured PCRs before enclave signing can start.

## Requires deployment / external security work
- [ ] Implement real distributed FROST participant rounds; current participant mode and `/sign/mpc` are disabled
- [ ] Authenticated confidential transport between MPC participants
- [x] Automate KMS seed provisioning, participant-scoped ciphertext storage, and broker deployment
- [ ] Run and independently review KMS bootstrap, rotation, rollback, and recovery on a real Nitro host
- [ ] External independent cryptographic/security audit of this application's integration
- [ ] Mainnet transaction builder and venue-specific execution adapters
- [ ] Full transaction reconciliation / retry state machine
- [ ] Geyser/direct pool state ingestion for every supported DEX

These are deployment/security assurance tasks, not placeholders pretending to be cryptography.
