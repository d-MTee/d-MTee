# Production gaps after v4

## Implemented in code
- [x] Real RFC 9591 FROST Ed25519 threshold signing
- [x] Real 2-of-3 DKG using Zcash Foundation `frost-ed25519`
- [x] Real signature-share aggregation and group-key verification
- [x] Nitro Enclave signer source
- [x] Nitro NSM attestation document generation
- [x] VSock parent/enclave communication path
- [x] PCR0-bound KMS policy template
- [x] Approval workflow and audit stream

## Requires deployment / external security work
- [ ] Run each MPC participant in a separate trust domain/host/account
- [ ] Authenticated confidential transport between MPC participants
- [ ] Production key persistence using KMS/HSM/enclave sealing
- [ ] External independent cryptographic/security audit of this application's integration
- [ ] Mainnet transaction builder and venue-specific execution adapters
- [ ] Full transaction reconciliation / retry state machine
- [ ] Geyser/direct pool state ingestion for every supported DEX

These are deployment/security assurance tasks, not placeholders pretending to be cryptography.
