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
the control service. A separate peer service pins each participant leaf
certificate and accepts direct DKG package and transcript traffic. Outbound
connections trust a peer-specific pinned CA and TLS server name. DKG round-one,
round-two, and finalization handlers are wired to the participant-local FROST
state machine. Every peer must agree on the complete transcript and group
public-key package before key activation. SignRound1 and SignRound2 now run
participant-local FROST operations. Every participant verifies its own signed
policy token and persists the one-use nonce before returning a commitment or
share. The Rust coordinator collects public commitments and signature shares,
checks all selected participants returned the same public-key package, then
aggregates and verifies the group signature. The TypeScript `/sign/mpc` route
checks that the group key is the approved wallet and attaches the signature to
the approved unsigned Solana transaction. `/execution/submit` remains a separate
guarded step.

This code is ready for controlled multi-host validation but has not been
validated against three independent AWS trust domains in this development
environment. Mainnet submission remains disabled unless the operator explicitly
sets `ENABLE_DISTRIBUTED_FROST_MAINNET=true` after completing that validation.

## What is real in the current code

The important point is that this is not a mock signing flow. The project uses the real `frost-ed25519` crate and executes the actual FROST steps:

- participant key generation
- DKG round 1 / round 2 flow
- signing share creation
- threshold signature aggregation
- verification against the aggregate verifying key

## Distributed DKG ceremony

Each participant is a separately configured process. The coordinator calls
`DkgRound1` on every node using the same session ID, threshold, and participant
count. Each participant creates its round-one package locally, stores its own
copy, and broadcasts that public package directly to the other pinned peers.
After every node reports round one complete, the coordinator calls
`DkgRound2`. Each node computes the canonical hash of the complete observed
round-one roster and publishes that manifest directly. A node returns
`DKG_TRANSCRIPT_ALL_PARTICIPANTS_PENDING` until it has the identical manifest
from every roster member; retry `DkgRound2` after all participants have
published.

Once the transcript agrees, each node runs FROST DKG round two locally and
sends each confidential round-two package directly to its recipient. The
coordinator then calls `DkgFinalize` on all nodes. Each node finalizes its
local share, publishes the resulting public-key-package hash, and activates
the epoch only after all participant hashes match. A pending finalization may
be retried; the same public package and DKG inputs are returned idempotently.
The coordinator sees only public round-one packages, status, and public-key
packages. It never receives FROST secret packages, private key shares, or
signing nonces.

After all peers agree on the final public package, each participant encrypts
its serialized private and public key packages with its configured AWS KMS key
and writes only ciphertext plus authenticated metadata to its local key-store
directory. The active epoch is selected by an atomically replaced manifest.
Startup restores only that exact epoch and checks participant identity,
threshold, roster size, transcript binding, local verifying share, and group
verifying key before enabling signing. Rotation is a fresh DKG epoch followed
by the all-peer agreement and active-manifest switch; old ciphertext is retained
for an explicitly controlled recovery window and is never auto-selected.

Set `MPC_KEY_STORE_DIR`, `FROST_KMS_KEY_ID`, and optionally `FROST_KMS_HELPER`
and `PYTHON_BIN` for every participant. The default helper is
`mpc/frost-signer/scripts/kms_share_store.py` and requires Python `boto3` plus
the participant's AWS workload credentials. Give each participant a separate
KMS key/role and constrain `kms:Decrypt` by the exact encryption context
(`application`, `participant_id`, `key_id`, transcript hash, threshold, roster
size, and package type). This encrypts shares at rest; the FROST participant
process still handles plaintext shares in memory and this is not Nitro sealing.
Validate backup restore, KMS key rotation, rollback, and destruction on the
target AWS account before custody use.

This is a genuine FROST threshold-signing implementation, not a visual placeholder or fabricated signature flow.

## Distributed signer architecture

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

The TypeScript API now orchestrates through the Rust coordinator process, while independent Rust workers perform participant-side signing.

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
- [x] confidential direct delivery of DKG round-two packages without exposing them to the coordinator
- [x] participant-authenticated transcript and final-key consistency
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
MPC_POLICY_AUTHORITY_PUBLIC_KEY_HEX
MPC_SIGNING_NONCE_DIR
MPC_KEY_STORE_DIR
FROST_KMS_KEY_ID
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
The ceremony deliberately requires every participant to agree. A missing or
disagreeing peer blocks key activation instead of allowing a threshold manifest
quorum, which would not provide safe Byzantine agreement for a 2-of-3 roster.

Signing RPCs independently verify the Ed25519 `policy_authorization` token
against `MPC_POLICY_AUTHORITY_PUBLIC_KEY_HEX`, bind its participant/request/key
and transaction-message hash to the call, enforce its short expiry, and persist
its one-use policy nonce under `MPC_SIGNING_NONCE_DIR` before producing a FROST
commitment. Each participant needs its own durable local nonce directory on a
filesystem with atomic exclusive file creation and fsync semantics. The same
signed token may be retried only for that exact request; reusing its nonce for
another request is rejected. Configure the same policy-authority public key on
all nodes, but keep signing shares and nonce stores in their separate trust
domains. Expired nonce records are removed after their signed expiry. The
coordinator's Redis claim is an additional control and is not trusted as the
participant's replay defense.

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
