# Security documentation index

This directory contains the production-facing security documents for the project.

## Document map

- [THREAT_MODEL.md](./THREAT_MODEL.md): attacker model, trust boundaries, and failure modes.
- [KEY_ROTATION.md](./KEY_ROTATION.md): participant key lifecycle, rotation, and revocation procedure.
- [KMS_BOOTSTRAP_ROTATION.md](./KMS_BOOTSTRAP_ROTATION.md): KMS-encrypted signing-seed provisioning, broker deployment, and Nitro key rotation.
- [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md): escalation, containment, and recovery workflow.

## Security principles

- fail closed on missing Nitro root pin, PCR allowlist, challenge, request binding, or active key state
- bind the participant to its parent IAM role (PCR3) and EC2 instance (PCR4)
- treat the parent EC2 as untrusted for plaintext key material
- append every signing decision to an atomic hash-linked audit stream and expose `/audit/verify`
- deny replayed, expired, or reused nonce values
- keep KMS access conditioned on attestation evidence

Protected endpoints require `Authorization: Bearer <credential-id>.<secret>`.
`API_AUTH_TOKENS` stores per-credential SHA-256 hashes and roles (`admin`,
`requester`, `approver`, `signer`, `auditor`); request creation is separate
from approval transitions and matching `principalId` values prevent one
configured principal from both requesting and approving. Signer credentials
are scoped to participant IDs. `/metrics` requires auditor authorization.
Rotate by deploying overlapping credential records, migrating clients,
then removing the old ID. Revocation takes effect after the API process is
restarted or rolled out. Nitro signing also requires the root certificate
fingerprint and approved per-participant PCR3/PCR4 plus PCR8 measurements; an
unconfigured verifier denies requests.
The distributed participant server and `/sign/mpc` endpoint are disabled because
the available participant-round implementation is still placeholder code. The
local FROST `demo` command remains a single-process cryptographic demonstration.

`GET /audit/verify` verifies the retained event chain against its Redis head.
For protection against an administrator who can rewrite both the stream and
head, export and independently retain periodic head hashes in a separate account
or immutable log service; Redis-only chaining cannot anchor itself externally.
