# Deployment runbook

This runbook captures the production checks needed before enabling live market traffic for the routing and signing system.

## 1. Environment configuration

Use the values from `.env.example` as a baseline and tighten them for the target environment.

```bash
MAX_ROUTE_DRIFT_RATIO=0.15
MAX_PRIORITY_FEE_LAMPORTS=10000
RPC_TIMEOUT_MS=5000
ENABLE_ROUTE_CONSISTENCY_GUARD=true
QUOTE_PROVIDER_RETRY_COUNT=2
QUOTE_PROVIDER_RETRY_DELAY_MS=150
QUOTE_PROVIDER_CIRCUIT_BREAKER_THRESHOLD=3
QUOTE_PROVIDER_CIRCUIT_BREAKER_RESET_MS=60000
TX_NONCE_MAX_AGE_MS=300000
```

## 2. Provider fallback policy

- Quote providers are retried before being marked unhealthy.
- Each venue is circuit-broken after `QUOTE_PROVIDER_CIRCUIT_BREAKER_THRESHOLD` consecutive failures.
- A provider stays unavailable until `QUOTE_PROVIDER_CIRCUIT_BREAKER_RESET_MS` elapses.
- Healthy providers remain eligible for comparison while degraded providers are isolated.

## 3. Nonce validation

Every transaction request must include a strictly increasing nonce. A request is rejected if:

- the nonce is missing or non-integer
- the nonce is not greater than the previously seen nonce
- the nonce is older than the configured `TX_NONCE_MAX_AGE_MS` when it appears timestamp-like

## 4. Pre-flight safety checklist

Before enabling live signing traffic, verify the following:

```bash
npm run check:redis
npm run check:participant-policy
npx tsc --noEmit
npx tsx --test tests/security.test.ts tests/router.test.ts
```

## 5. Production deployment checklists

- Redis must be reachable and configured for the target environment.
- Participant host and account IDs must match the allowlist for each signer.
- Quote drift and fee limits must remain within the approved policy envelope.
- Transaction builder must enforce nonce monotonicity before a route is accepted.
- Any failed provider must remain isolated until the circuit breaker reset window expires.
