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

Sensitive routes use separate `admin`, `requester`, `approver`, `signer`, and
`auditor` roles. Administrators can access all protected routes. Approval
creation requires `requester`; approval state changes require `approver` so a
requester credential alone cannot approve its own request. Signing and attestation challenges require
`signer`; audit and read-only key status require `auditor`; key initialization
and lifecycle changes require `admin`. A signer credential is restricted to
the participant ID embedded in its credential record.

Configure `API_AUTH_TOKENS` as a JSON array. The API stores only a SHA-256 hash
of each 32-byte-or-longer random secret. The client bearer value is
`<credential-id>.<secret>`; never put the raw bearer value in this JSON. Generate
a credential with:

```bash
node scripts/generate-api-credential.mjs ops-admin admin
node scripts/generate-api-credential.mjs request-a requester
node scripts/generate-api-credential.mjs approver-a approver
node scripts/generate-api-credential.mjs signer-p1 signer p1
node scripts/generate-api-credential.mjs audit-reader auditor
```

Merge each printed `credential` object into `API_AUTH_TOKENS` and deliver its
`bearerToken` to the intended client through a secret manager. To rotate, issue
a new ID/secret, deploy a registry containing both old and new records, migrate
clients, then remove the old record and redeploy. To revoke, remove its record
and restart/roll out the API. An empty or malformed registry makes protected
requests fail closed with `503 API_AUTH_NOT_CONFIGURED`; invalid credentials
return `401 UNAUTHORIZED` and valid credentials without the required role return
`403 FORBIDDEN`.

Role map:

| Route | Required role |
| --- | --- |
| `POST /approval` | `requester` |
| `GET /approval/:id` | `requester`, `approver`, or `auditor` |
| `POST /approval/:id/:state` | `approver` |
| `POST /attestation/challenge`, `POST /sign/nitro`, `POST /sign/mpc` | `signer` scoped to the request participant |
| `GET /audit`, `GET /audit/verify`, `GET /key/status` | `auditor` |
| `POST /key/init`, `POST /key/:state` | `admin` |

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
