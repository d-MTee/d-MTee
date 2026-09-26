# Java MCP + Rust FROST participant architecture

This document describes the next implementation step after the current local FROST proof-of-concept in `mpc/frost-signer`.

## Current state

The existing Rust implementation proves that the project can run a real FROST `frost-ed25519` DKG and threshold signing flow in a single process. That is valuable because it demonstrates the cryptographic path, but it does not yet model a real distributed custody workflow.

Current shape:

```text
main.rs
  ├── Participant 1 created
  ├── Participant 2 created
  ├── Participant 3 created
  ├── DKG executed
  ├── 2-of-3 signing executed
  └── verification executed
```

This is a local demo, not a multi-party distributed signer.

## Target architecture

```text
                       Java / MCP Server
                              │
                          Sign request
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          Rust P1         Rust P2         Rust P3
             │               │               │
             └───────────────┼───────────────┘
                             ▼
                     FROST threshold signing
                             │
                             ▼
                     Signature / verification
```

The Java layer acts as orchestration and policy control. The Rust participants are the actual cryptographic workers.

## Responsibilities

### Java / MCP server

- create and track signing sessions
- select participants and threshold
- coordinate DKG rounds
- relay round data between participant nodes
- collect signature shares
- perform aggregate verification
- enforce request IDs, replay protection, session TTL, and approvals

### Rust participant nodes

- hold a local participant identity
- store encrypted key share material
- run DKG round 1 and round 2
- generate signing nonces and commitments
- sign a message share when authorized
- return only signed share data, not full secret material

## Protocol pattern

### 1. Session creation

Java creates a session with participant IDs and threshold:

```json
{
  "sessionId": "sess-001",
  "participants": ["p1", "p2", "p3"],
  "threshold": 2,
  "message": "hello-world",
  "encoding": "utf8"
}
```

### 2. DKG round 1

Each participant generates a round-1 package locally.

```text
Java -> P1: DkgRound1(sessionId)
Java -> P2: DkgRound1(sessionId)
Java -> P3: DkgRound1(sessionId)
```

### 3. DKG round 2

Java relays round-1 packages and each participant finishes DKG.

```text
Java -> P1: DkgRound2(sessionId, round1Secret, peerPackages)
Java -> P2: DkgRound2(sessionId, round1Secret, peerPackages)
Java -> P3: DkgRound2(sessionId, round1Secret, peerPackages)
```

### 4. Signing flow

Each participant creates nonce and commitment for the selected message.

```text
Java -> P1: SignRound1(sessionId, message)
Java -> P2: SignRound1(sessionId, message)
```

Then Java aggregates commitments and sends the signing package to selected participants.

```text
Java -> P1: SignRound2(sessionId, signingPackage, nonce, key)
Java -> P2: SignRound2(sessionId, signingPackage, nonce, key)
```

### 5. Aggregate and verify

Java collects the shares and executes final threshold aggregation and verification.

## Security boundaries required before production

The following elements are required before the architecture is custody-grade:

- encrypted share persistence
- individual participant trust domains
- mTLS / authenticated transport
- session IDs and replay protection
- nonce lifecycle tracking
- attestation and KMS or HSM boundary
- approval / policy gate before signing is released

## Proposed directory structure

```text
mini-dflow-v5/
  java-mcp/
    src/
      app/
      service/
      client/
      store/
      security/
  mpc/
    proto/
      mpc_service.proto
    frost-signer/
      src/
        main.rs
        participant_runtime.rs
```

## Implementation order

1. define the gRPC contract
2. create a participant process binary per signer
3. add Java session orchestration service
4. implement DKG round relay
5. implement signing round relay
6. add secret-share encryption and state persistence
7. add mTLS, replay protection, and approval checks
8. bind the signing path to TEE or HSM boundaries

## Important note

The current Rust flow is strong evidence that the actual FROST threshold mechanism works. The missing step is not cryptographic correctness; it is distributed coordination, credential isolation, and custody-grade operational security.
