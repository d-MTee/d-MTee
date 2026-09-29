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
- GET `/metrics` (auditor auth)
- POST `/attestation/challenge` (Bearer auth; requires `participantId` and `requestId`)
- GET `/audit/verify` (Bearer auth; verifies the complete retained hash chain)
- POST `/execution/submit` (signer auth; submits an approved signed transaction)
- GET `/execution/:approvalId` (requester/approver/auditor; reconciles submission status)

## Authorization

Sensitive routes use separate `admin`, `requester`, `approver`, `signer`, and
`auditor` roles. Administrators can access all protected routes. Approval
creation requires `requester`; approval state changes require `approver`.
Approval records store requester and approver `principalId` values. Assign the
same stable principal ID to all credentials held by the same human or service;
the API rejects approval when those IDs match, including separately issued
requester and approver credentials. Signing and attestation challenges require
`signer`; audit and read-only key status require `auditor`; key initialization
and lifecycle changes require `admin`. A signer credential is restricted to
the participant ID embedded in its credential record.

Configure `API_AUTH_TOKENS` as a JSON array. The API stores only a SHA-256 hash
of each 32-byte random secret (43-character base64url encoding). The client bearer value is
`<credential-id>.<secret>`; never put the raw bearer value in this JSON. Generate
a credential with:

```bash
node scripts/generate-api-credential.mjs ops-admin admin
node scripts/generate-api-credential.mjs request-a requester - trader-17
node scripts/generate-api-credential.mjs approver-a approver - trader-17
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
| `POST /execution/submit` | `signer` scoped to the request participant |
| `GET /execution/:approvalId` | `requester`, `approver`, or `auditor`; record owner or auditor only |
| `GET /audit`, `GET /audit/verify`, `GET /key/status` | `auditor` |
| `GET /metrics` | `auditor` |
| `POST /key/init`, `POST /key/:state` | `admin` |

Each credential record must include a stable `principalId`. The generator uses
the credential ID by default; pass the same principal ID explicitly for every
role credential belonging to one operator. Principal IDs are configuration
claims and must be managed by the organization; they are not an external
identity-provider assertion.

## Rate limits

Public market reads are limited to 60–120 requests per source IP per minute;
route rechecks and simulation endpoints use lower limits. Approval writes are
limited to 20/minute, signing and attestation challenge requests to 10–20/minute,
key lifecycle writes to 5–10/minute, and audit/metrics reads to 10–60/minute.
Counters are shared through Redis across API instances. Exceeded requests return
`429 RATE_LIMITED` with `Retry-After`. If Redis is unavailable, limited routes
fail closed with `503 RATE_LIMIT_STORAGE_UNAVAILABLE`. Limits use the socket
peer address; configure trusted network-level limits at the ingress for
deployments behind a proxy.

## Solana transaction submission

Submission is disabled by default. To enable a devnet rollout, set
`ENABLE_LIVE_SUBMISSION=true`, `DRY_RUN=false`, `SOLANA_CLUSTER_ID=solana-devnet`,
and pin `SOLANA_EXPECTED_GENESIS_HASH` to the trusted RPC's `getGenesisHash`
result. Mainnet submission is hard-disabled until the distributed FROST signing
path is implemented and independently reviewed.

The approval must bind the exact transaction message hash, wallet, cluster,
policy, and `lastValidBlockHeight`. After the signature is issued, send the fully
signed base64 `VersionedTransaction` to `POST /execution/submit` with a
participant-scoped signer credential. The API verifies the message hash and fee
payer, checks the RPC genesis hash and recent blockhash, simulates with signature
verification, submits through the configured RPC, and records confirmation
state. A retry must use the same signed bytes. Use `GET /execution/:approvalId`
to reconcile an accepted transaction. This devnet integration uses the existing
Nitro single-enclave signer. It does not make that signer an MPC deployment.

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
