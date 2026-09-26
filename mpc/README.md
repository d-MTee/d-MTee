# MPC signing operational guide

This module contains the local FROST-based threshold signing flow used to validate the threshold signing design before it is bound to a TEE and KMS policy boundary.

## Purpose

- demonstrate 2-of-3 threshold signing
- perform DKG without a trusted dealer
- verify the aggregate signature using the public key package
- provide a reproducible cryptographic proof for the broader signing architecture

## Implementation summary

- Rust implementation under `mpc/frost-signer/src/main.rs`
- FROST Ed25519 signing library
- local DKG and signing flow for three participants
- aggregate verification step before returning success

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

This is a protocol demonstration, not a production key ceremony. The demo intentionally keeps participants in the same process to make local testing straightforward.

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
