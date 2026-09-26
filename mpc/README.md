# MPC signing operational guide

This module is the proof-of-concept implementation for a real FROST Ed25519 threshold signing flow. It demonstrates the cryptographic logic correctly, but it is still a local simulator rather than a distributed custody system.

## Current status

The current code does not yet model separate networked participants operating in different processes or trust domains. Instead, it runs the full DKG and signing flow inside one Rust process:

```text
main.rs
  ├── Participant 1 created
  ├── Participant 2 created
  ├── Participant 3 created
  ├── DKG executed
  ├── 2-of-3 signing executed
  └── signature verification executed
```

This means the implementation is a strong local validation of FROST behavior, but it is not yet a custody-grade distributed system.

## What is real in the current code

The important point is that this is not a mock signing flow. The project uses the real `frost-ed25519` crate and executes the actual FROST steps:

- participant key generation
- DKG round 1 / round 2 flow
- signing share creation
- threshold signature aggregation
- verification against the aggregate verifying key

This is a genuine FROST threshold-signing implementation, not a visual placeholder or fabricated signature flow.

## Target architecture after the demo phase

The next meaningful evolution is a split architecture in which the Java application layer orchestrates signing requests and each Rust participant runs as an independent signer process:

```text
                Java / MCP Server
                       │
                   Sign Request
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
        Rust P1    Rust P2    Rust P3
         share       share       share
            │          │          │
            └──────┬───┴──────┬───┘
                   ▼
              FROST signing
                   │
                   ▼
            Signature / Verify
```

This would produce a more honest architecture: Java agent or MCP service as the orchestration layer, Rust workers as participant signers, and the threshold signing protocol between them.

## Production requirements beyond the current demo

To move from a local protocol demo to a Custody-level production design, the following controls are required:

- key share storage in encrypted form
- participant separation across isolated processes or hosts
- per-participant authentication and authorization
- replay protection and request ID validation
- nonce lifecycle management and secure randomness handling
- network transport protection for DKG and signing messages
- HSM or TEE-backed key protection for critical share material
- attestation and policy enforcement before secret release

## Prerequisites

- Rust toolchain installed
- Cargo available in `PATH`
- access to a terminal that can run the local signing demo

## Local quick start

From the repo root:

```bash
cd mpc/frost-signer
cargo run --release -- demo
```

Optional custom payload:

```bash
cargo run --release -- demo "hello-world"
```

## Operational model

This is a protocol demonstration, not a production key ceremony. The demo intentionally keeps participants in the same process to make local testing straightforward and deterministic.

In production:

- each participant should run in a separate trust domain
- key material should stay inside a controlled boundary
- DKG traffic should be authenticated and confidential
- signing should only proceed after attestation and policy checks pass

## Failure conditions

Treat the local flow as invalid for production if:

- signing shares are logged in plaintext
- any participant runs outside a controlled trust boundary
- DKG material is transferred without auth or integrity protection
- a release decision occurs before attestation is validated

## Safety expectations

- keep developer logs free of signing material
- separate deployment, key management, and release roles
- require attestation and KMS policy verification before any signing key is used
- preserve the local demo as a protocol test, not as a live signing environment
