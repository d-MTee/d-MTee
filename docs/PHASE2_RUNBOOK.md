# Phase 2 Security Boundary Runbook

This runbook covers the deployment and operational checks required before the project can be considered production-ready for a live signing environment.

## Required production boundaries

Each participant must operate in a separate trust domain, with its AWS parent identity measured:

- `p1` on `host-p1` and `account-p1`
- `p2` on `host-p2` and `account-p2`
- `p3` on `host-p3` and `account-p3`
- `coordinator` on `coordinator-host` and `coordinator-account`

The verifier binds each participant to PCR3 (parent IAM role/account) and PCR4 (parent instance); request-supplied host/account labels are ignored. The FROST participant binary runs DKG over participant-pinned mutual TLS and refuses to activate a key epoch unless every participant agrees on the transcript and final public-key package. Signing RPCs and `/sign/mpc` remain disabled until each signer independently validates policy and replay state and key-share recovery is implemented.

## Preflight commands

```bash
npm install
npm run redis:up
npm run check:redis
PARTICIPANT_ID=p1 npm run check:participant-policy
```

## Admission checks

Before a signing request is accepted:

1. Participant ID is recognized and trusted.
2. Nitro COSE signature and certificate chain validate to the configured AWS root pin.
3. PCR3, PCR4, and PCR8 match the measured participant allowlist.
4. The signing key state is `ACTIVE`.
5. The request is bound to participant, request ID, challenge nonce, transaction hash, key epoch, route, policy, and approval.

## Recovery actions

If a participant is rejected:

- stop new signing traffic for that participant
- verify host/account mapping
- check the attestation payload for drift or stale nonce
- validate the key lifecycle state and rotate if required
- review audit stream entries for rejected transition and request events

## mTLS and confidential transport

The participant command now provides mTLS direct DKG transport. Before treating it as production-ready, the deployment should prove:

- each participant authenticates with a unique certificate
- every participant presents the configured pinned leaf certificate; outbound connections trust only that peer's pinned CA and TLS server name
- transcript equivocation, package replay, and final public-key mismatch stop key activation
- the service requires mutual trust before signing traffic is accepted
- the transport can only be used from the allowlisted host/account set

## KMS and sealing procedures

The trust boundary should be enforced with:

- KMS access bound to enclave attestation
- sealed secrets managed outside the enclave
- ciphertext-only storage for private shares
- explicit key rotation procedures and rollback checks

This runbook should be reviewed alongside the AWS Nitro deployment and attestation policy documents before any live execution path is enabled.
