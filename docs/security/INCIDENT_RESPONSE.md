# Incident response

## 1. Containment

If a route drift, replay, or attestation mismatch is detected:

- stop new signing requests immediately
- isolate the affected participant or provider
- quarantine the route and the build artifacts associated with the request
- preserve logs and audit records

## 2. Evidence collection

Capture:

- attestation payload
- participant host/account identifiers
- route and approval token
- nonce and transaction payload
- provider health state and error logs
- Redis audit stream records

## 3. Triage steps

1. determine whether the issue is provider, participant, or policy-related
2. verify whether the request was replayed or stale
3. confirm whether host/account binding mismatched expected values
4. assess whether the participant key is active or revoked
5. verify whether the chain state or nonce sequence was invalid

## 4. Recovery and re-enablement

Re-enable traffic only after:

- the root cause is identified and fixed
- the affected provider or participant is isolated or replaced
- nonce validation and attestation checks pass
- the route drift guard and safety limits remain within policy
- the audit trail clearly shows the remediation path
