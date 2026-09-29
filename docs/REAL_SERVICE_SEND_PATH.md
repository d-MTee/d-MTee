# Real service transaction send path

This document describes the intended production execution path. The current API does not submit Solana transactions or implement confirmation polling; `src/execution/send.ts` currently provides request validation and lifecycle data structures only.

## 1. Objectives

The send path must guarantee that a route is:

- policy-approved
- route-consistent with the quote and simulation assumptions
- bound to a valid participant identity and attestation
- built with a nonce that is strictly increasing and fresh
- safe to retry without creating duplicate execution side effects

## 2. Execution pipeline

```text
request intent
  -> approval and policy validation
  -> quote acquisition with retry + breaker
  -> route consistency + drift check
  -> nonce generation / reuse validation
  -> transaction building
  -> MPC signing
  -> Solana RPC submission
  -> confirmation polling
  -> audit record + idempotency checkpoint
```

## 3. Idempotency model

Every transaction must carry a deterministic idempotency key derived from:

- participant ID
- route hash
- nonce
- amount
- chain ID
- approval token

The key should be stored in Redis with a TTL that exceeds the expected confirmation time. If the same operation is retried, the system checks the key before resubmitting the transaction.

## 4. Retry and timeout policy

Recommended production defaults:

- retry count: 2
- retry delay: 150 ms backoff
- RPC timeout: 5 s
- send timeout: 60 s
- re-send cap: 3 total attempts before route rejection

This prevents sustained provider noise while preserving the fail-closed nature of the policy gate.

## 5. Confirmation lifecycle

1. Submit to RPC with a valid signed transaction.
2. Poll for status using a bounded retry loop.
3. Accept states in this order:
   - `pending` -> `submitted` -> `confirmed`
4. Reject or quarantine on:
   - `BlockhashNotFound`
   - `TransactionExpiredBlockheightExceeded`
   - RPC timeout
   - duplicate nonce or stale confirmation

## 6. Transaction builder contract

The builder should always enforce:

- `nonce > previousNonce`
- `nonce` within allowed age
- canonical route digest included in the signing payload
- amount and route encoded exactly as evaluated by the policy layer
- request ID added for replay protection

## 7. Audit and observability

Each step emits a structured event:

- `route_selected`
- `route_rejected`
- `provider_failed`
- `provider_circuit_opened`
- `nonce_validated`
- `transaction_built`
- `tx_submitted`
- `tx_confirmed`
- `tx_failed`

This should be persisted in Redis and optionally forwarded to a durable event store.

## 8. Production guardrails

- deny by default on any route drift over threshold
- deny by default on stale or reused nonce
- deny by default on untrusted attestation or host/account mismatch
- isolate a provider after repeated failures
- require durable audit records prior to live submit

## 9. Recommended next implementation steps

1. Add `src/execution/send.ts` or a `TransactionSender` service to encapsulate submission and confirmation logic.
2. Store idempotency keys and nonces in Redis with TTL.
3. Add Prometheus counters for `tx_submitted_total`, `tx_confirmed_total`, and `tx_failed_total`.
4. Wire API `/submit` or `/execute` endpoint to the validated send path.
5. Add a dedicated integration test covering retry + idempotency + nonce reuse.

Until that sender is implemented, `dflow_tx_submitted_total`,
`dflow_tx_confirmed_total`, and `dflow_tx_failed_total` count calls that construct
corresponding `SendOutcome` records only. They are not evidence of an RPC submit
or chain confirmation.
