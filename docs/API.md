# API

- GET `/health`
- GET `/prices`
- GET `/quote?amount=10`
- GET `/route/split?amount=100`
- GET `/route/jit?amount=100`
- GET `/policy?amount=100`
- GET `/quote/jupiter?inputMint=...&outputMint=...&amount=...`
- GET `/simulate`
- GET `/priority-fees`
- POST `/approval`
- GET `/approval/:id`
- POST `/approval/:id/:state`
- GET `/audit`
- GET `/key/status`
- POST `/key/init`
- POST `/key/:state`
- GET `/metrics`
- POST `/attestation/challenge` (Bearer auth; requires `participantId` and `requestId`)
- GET `/audit/verify` (Bearer auth; verifies the complete retained hash chain)

## Authorization

`POST /approval`, `GET /approval/:id`, `POST /approval/:id/:state`, key lifecycle
routes, audit routes, attestation challenges, and signing routes require
`Authorization: Bearer <API_BEARER_TOKEN>`. If a 32-character-or-longer token is
not configured, these routes return `503 API_AUTH_NOT_CONFIGURED`.

## Nitro signing contract

1. Request a challenge with `{ "participantId": "p1", "requestId": "..." }`.
2. Ask the enclave to attest the returned base64 nonce and exact `userData` string.
3. Send `/sign/nitro` a COSE attestation document plus the same challenge and
   request IDs, transaction bytes (base64) and SHA-256 hash, approved
   `approvalId`, `keyId`, route/policy hashes, trade fields, and
   `policyAuthorization`.

The signer verifies the AWS Nitro signature and certificate chain, freshness,
one-use nonce, request binding, participant PCR3/PCR4, approved PCR8, active
Redis key epoch, and exact approval fields. Administrative host/account strings
or caller-authored PCR values are not accepted as evidence. Signing approvals
must store `transactionMessageHash`, `routeHash`, and `policyHash`; incomplete
approval records are rejected.

The enclave signs the exact decoded Solana transaction-message bytes so the
signature is chain-valid. The API verifies their SHA-256 against the approval
and checks route, policy, chain, wallet, key epoch, and replay metadata before
passing those bytes to the signer.

`policyAuthorization` is a compact token `base64url(payload).base64url(signature)`
with an Ed25519 signature from an external policy authority. The API and EIF pin
the same raw public key (`POLICY_AUTHORITY_PUBLIC_KEY_HEX` in the API and
`NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX` in the EIF). The signed JSON claims must
contain version, participant/request/key IDs, transaction hash, approval/route/
policy IDs, chain and wallet IDs, trade fields, `expiresAt` (Unix milliseconds,
no more than 60 seconds ahead), and a unique nonce. The authority private key is
not stored in this repository or on the parent EC2 host. The enclave checks the
token before signing, so direct parent-to-VSock calls cannot bypass the policy
gate.

`/sign/mpc` returns `503 DISTRIBUTED_MPC_SIGNING_NOT_CONFIGURED` until real
distributed FROST round handlers and authenticated participant transport exist.
