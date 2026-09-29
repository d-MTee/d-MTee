# MPC signing operational guide

This module is the proof-of-concept implementation for a real FROST Ed25519 threshold signing flow. It demonstrates the cryptographic logic correctly, but it is still a local simulator rather than a distributed custody system.

## Current status

The `demo` command still runs full DKG and signing in one Rust process. A
participant-local FROST state machine now keeps DKG secrets, key packages, and
one-use signing nonces inside its process, but those operations are not yet
connected to the network RPC handlers:

```text
main.rs
  ├── Participant 1 created
  ├── Participant 2 created
  ├── Participant 3 created
  ├── DKG executed
  ├── 2-of-3 signing executed
  └── signature verification executed
```

The gRPC listener uses mutual TLS and pins the coordinator leaf certificate on
the control service. A separate peer service pins every participant client
certificate and accepts only DKG round-two delivery messages. Outbound peer
connections use a peer-specific pinned CA and expected TLS server name. The
round RPCs remain `UNIMPLEMENTED` until the DKG transcript and signer-side
policy stages are complete.
Every DKG/signing RPC remains explicitly `UNIMPLEMENTED`; the service does not
claim participant readiness or return placeholder signatures. The current
implementation is still not a distributed custody system.

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

To move from the local protocol demo and mTLS control-plane scaffold to a
custody-grade distributed design, the following controls are required:

- key share storage in encrypted form
- participant separation across isolated processes or hosts
- per-participant authentication and authorization
- replay protection and request ID validation
- nonce lifecycle management and secure randomness handling
- network transport protection for DKG and signing messages
- HSM or TEE-backed key protection for critical share material
- attestation and policy enforcement before secret release
- confidential direct delivery of DKG round-two packages without exposing them to the coordinator
- participant-authenticated broadcast consistency for DKG round one
- independent policy-token verification and persistent replay protection at every signing participant
- encrypted key-share persistence and key-epoch recovery/rotation

The participant command requires these environment variables:

```text
MPC_SERVER_CERT_PEM
MPC_SERVER_KEY_PEM
MPC_CLIENT_CA_PEM
MPC_COORDINATOR_CERT_SHA256
MPC_PEER_CERT_PINS_JSON
MPC_PEER_ENDPOINTS_JSON
```

`MPC_PEER_CERT_PINS_JSON` is a JSON object mapping each remote participant ID
to the lowercase SHA-256 of its leaf certificate in DER form, for example
`{"p2":"<64 hex chars>","p3":"<64 hex chars>"}`. Every pin must be unique.
`MPC_PEER_ENDPOINTS_JSON` maps those same participant IDs to HTTPS endpoint,
certificate DNS name, the path to that participant's private CA PEM, and the
SHA-256 of the exact CA PEM bytes, for example
`{"p2":{"endpoint":"https://p2.internal:9001","server_name":"p2.internal","ca_pem_path":"/etc/dflow/peer-p2-ca.pem","ca_sha256":"<64 hex chars>"}}`.
The two rosters must match exactly. Protect these files as deployment trust
configuration and distribute them through a secret/configuration manager.

The server will refuse to start when any value is missing or malformed. The
default bind address is loopback. If binding to a network interface, expose the
port only to the pinned coordinator through a private network policy.

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
