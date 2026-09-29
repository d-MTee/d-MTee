# Phase 2 Security Boundary Runbook

This runbook covers the deployment and operational checks required before the project can be considered production-ready for a live signing environment.

## Required production boundaries

Each participant must operate in a separate trust domain:

- `p1` on `host-p1` and `account-p1`
- `p2` on `host-p2` and `account-p2`
- `p3` on `host-p3` and `account-p3`
- `coordinator` on `coordinator-host` and `coordinator-account`

Any request that mixes a participant identity with a different host or account is rejected by the runtime security policy.

## Preflight commands

```bash
npm install
npm run redis:up
npm run check:redis
npm run check:participant-policy
npm test -- --test-name-pattern "participant authorization|key lifecycle|attestation|signing endpoint|runtime policy accepts active key state"
```

## Admission checks

Before a signing request is accepted:

1. Participant ID is recognized and trusted.
2. Attestation record is present and passes PCR verification.
3. Participant host and account identity are consistent with the expected deployment map.
4. The signing key state is `ACTIVE`.
5. The request is bound to the participant and enclave identity.

## Recovery actions

If a participant is rejected:

- stop new signing traffic for that participant
- verify host/account mapping
- check the attestation payload for drift or stale nonce
- validate the key lifecycle state and rotate if required
- review audit stream entries for rejected transition and request events

## mTLS and confidential transport

The project should use mTLS or authenticated confidential transport for participant-to-participant communications. At minimum, the deployment should prove:

- each participant authenticates with a unique certificate
- the service requires mutual trust before signing traffic is accepted
- the transport can only be used from the allowlisted host/account set

## KMS and sealing procedures

The trust boundary should be enforced with:

- KMS access bound to enclave attestation
- sealed secrets managed outside the enclave
- ciphertext-only storage for private shares
- explicit key rotation procedures and rollback checks

This runbook should be reviewed alongside the AWS Nitro deployment and attestation policy documents before any live execution path is enabled.
