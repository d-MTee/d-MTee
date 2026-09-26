# Real MPC / Threshold Signing

This directory contains the production-oriented reference implementation for a real FROST Ed25519 threshold-signing flow.

## What is implemented

- RFC 9591 FROST threshold signatures
- 2-of-3 threshold signing
- Distributed Key Generation (DKG) rather than a trusted-dealer setup
- Real commitment, share generation, and aggregation steps
- Final verification against the aggregate verifying key
- Local demonstration mode for reproducible testing and protocol validation

The Rust implementation is based on the Zcash Foundation `frost-ed25519` crate. In a live deployment, each participant must communicate over authenticated, confidential channels and run in a separate security boundary.

## Local run

```bash
cd mpc/frost-signer
cargo run --release -- demo
```

Optional message input:

```bash
cargo run --release -- demo "hello-world"
```

## Operational notes

The local sample intentionally keeps the three participants in a single process so it can run on a developer machine. This proves the cryptographic workflow, but it does not provide fault isolation or independent trust domains.

For a production deployment, each participant should run on a separate host, account, or enclave boundary, and DKG/signing traffic should be transported over mutual TLS or an equivalent authenticated confidential channel.

## Safety expectations

- Do not treat this as a production key ceremony.
- Keep signing material out of plaintext developer logs.
- Require attestation and policy verification before releasing any key material.
- Use separate operational roles for release, key management, and deployment.
