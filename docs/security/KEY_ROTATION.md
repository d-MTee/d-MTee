# Key rotation and revocation

## 1. Rotation policy

Key rotation must be explicit, measured, and auditable.

- each participant key has a lifecycle state: GENERATED -> ACTIVE -> ROTATING -> ACTIVE or REVOKED
- signing requests are rejected when the key is not ACTIVE
- rotation must use a new KMS-wrapped signing seed, key epoch ID, and approved PCR3/PCR4/PCR8 measurements
- old shares must never remain in plaintext on shared infrastructure

## 2. Revocation flow

When a participant is suspected to be compromised:

1. mark the participant key as REVOKED
2. block signing requests immediately
3. remove the participant from the allowlist
4. reissue attestation for a replacement participant environment
5. rebuild trust and confirm key material in a fresh enclave instance

## 3. Recovery checklist

- verify attestation records are valid
- rotate KMS policy and certificates as needed
- confirm the new Nitro evidence matches the participant's role and instance PCR allowlist
- validate and re-run the security regression suite
- archive old audit evidence before re-enabling traffic
