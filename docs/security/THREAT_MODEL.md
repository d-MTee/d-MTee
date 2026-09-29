# Threat model

## 1. Trust boundaries

The primary trust boundary sits between the application process and the Nitro enclave. The parent EC2 instance is treated as untrusted for plaintext key-share handling.

## 2. Assets

- route configuration
- quote provider trust state
- participant key material
- nonce and idempotency state
- audit records
- KMS-encrypted secrets

## 3. Threats

- replayed requests
- stale quote injection
- malicious provider response
- Nitro PCR3 parent-role mismatch and PCR4 parent-instance mismatch
- attestation forgery
- stale or reused nonce
- compromised coordinator logic
- untrusted RPC or fallback route

## 4. Mitigations

- AWS Nitro COSE signature and pinned-root certificate-chain verification before signing
- request-bound, short-lived, one-use nonce and signed user_data
- participant-specific PCR3/PCR4 plus approved PCR8 measurements
- key lifecycle enforcement
- provider circuit breaker and retry limits
- route drift checks
- transaction nonce validation
- Redis atomic append-only SHA-256 audit chain with full-chain verification

The application does not trust caller-supplied host/account strings. PCR3 binds the
parent IAM role (and therefore its AWS account role identity); PCR4 pins the
specific parent instance. A separate production trust-domain design is still
required for multiple independent FROST participants.

## 5. Residual risk

The system still depends on:

- secure CI/CD and artifact signing
- AWS account isolation
- key ceremony discipline
- incident response capability
- external security review

These are operational controls, not code-level guarantees.
