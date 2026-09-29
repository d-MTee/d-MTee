# Security documentation index

This directory contains the production-facing security documents for the project.

## Document map

- [THREAT_MODEL.md](./THREAT_MODEL.md): attacker model, trust boundaries, and failure modes.
- [KEY_ROTATION.md](./KEY_ROTATION.md): participant key lifecycle, rotation, and revocation procedure.
- [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md): escalation, containment, and recovery workflow.

## Security principles

- fail closed on missing Nitro root pin, PCR allowlist, challenge, request binding, or active key state
- bind the participant to its parent IAM role (PCR3) and EC2 instance (PCR4)
- treat the parent EC2 as untrusted for plaintext key material
- append every signing decision to an atomic hash-linked audit stream and expose `/audit/verify`
- deny replayed, expired, or reused nonce values
- keep KMS access conditioned on attestation evidence

All administrative and signing endpoints require `Authorization: Bearer …` with
`API_BEARER_TOKEN` configured to a random value of at least 32 characters. Nitro
signing also requires the root certificate fingerprint and approved per-participant
PCR3/PCR4 plus PCR8 measurements; an unconfigured verifier denies requests.
The distributed participant server and `/sign/mpc` endpoint are disabled because
the available participant-round implementation is still placeholder code. The
local FROST `demo` command remains a single-process cryptographic demonstration.

`GET /audit/verify` verifies the retained event chain against its Redis head.
For protection against an administrator who can rewrite both the stream and
head, export and independently retain periodic head hashes in a separate account
or immutable log service; Redis-only chaining cannot anchor itself externally.
