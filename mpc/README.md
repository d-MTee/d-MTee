# Real MPC / Threshold Signing

This directory replaces the old `ThresholdSignerAdapter` placeholder with a real FROST(Ed25519,SHA-512) implementation.

- RFC 9591 FROST
- 2-of-3 threshold
- Distributed Key Generation (DKG), not a trusted-dealer-only demo
- Real signing commitments, signature shares and aggregation
- Final signature verified against the group Ed25519 public key

The Rust implementation is based on the Zcash Foundation `frost-ed25519` crate. The upstream project documents DKG and signing APIs and notes that participants must communicate through authenticated/confidential channels in a real deployment.

Run:

```bash
cd mpc/frost-signer
cargo run --release -- demo
```

The sample intentionally simulates the three participants in one process so it can be run locally. **That proves the cryptographic protocol, but it does not provide distributed fault isolation.** Production deployment must run each participant as a separate service/host/account/security domain and transport DKG/signing messages over authenticated confidential channels.
