# Operations metrics and alert templates

The quote-provider, route, signing-policy, and audit integrity metrics below are emitted by the current service. Transaction counters are wired to `SendOutcome` state creation, but there is no live transaction submitter yet; transaction alerts become operational only when that sender is connected.

## 1. Core metrics

The service should emit the following metrics:

- `dflow_quotes_total`
- `dflow_routes_total`
- `dflow_route_latency_ms`
- `dflow_provider_failures_total`
- `dflow_provider_circuit_open_total`
- `dflow_tx_submitted_total`
- `dflow_tx_confirmed_total`
- `dflow_tx_failed_total`
- `dflow_nonce_rejected_total`
- `dflow_attestation_rejected_total`
- `dflow_runtime_policy_rejected_total`

## 2. Alert thresholds

Suggested alert rules:

### Provider availability

```yaml
- alert: QuoteProviderFailureRateHigh
  expr: rate(dflow_provider_failures_total[5m]) > 0.3
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: Quote provider failure rate is elevated
```

### Route latency

```yaml
- alert: RouteLatencyP95High
  expr: histogram_quantile(0.95, sum(rate(dflow_route_latency_ms_bucket[5m])) by (le)) > 500
  for: 10m
  labels:
    severity: warning
```

### Nonce misuse

```yaml
- alert: NonceReuseDetected
  expr: rate(dflow_nonce_rejected_total[5m]) > 0
  for: 5m
  labels:
    severity: critical
```

### Attestation rejection spike

```yaml
- alert: AttestationRejectionSpike
  expr: rate(dflow_attestation_rejected_total[5m]) > 0.1
  for: 5m
  labels:
    severity: critical
```

## 3. Pager and Slack template

### Critical alert

```text
Severity: critical
Service: dflow-router
Alert: NonceReuseDetected
Summary: transaction requests with reused or expired nonces are being rejected.
Runbook: check Redis nonce state, participant ordering, and signer host identity.
```

### Warning alert

```text
Severity: warning
Service: dflow-router
Alert: QuoteProviderFailureRateHigh
Summary: provider failure rate exceeded acceptable threshold.
Runbook: inspect provider health, retry logs, and circuit-breaker state.
```

## 4. Operational checklist

- alert on provider circuit opening
- alert on blocked attestation and runtime policy decisions
- alert on nonce rejection or replay attempts
- alert on sustained route drift or fee spikes
- page for repeated transaction failure after a healthy route was selected

## 5. Recommended next steps

1. Wire the alert definitions into a Grafana or Alertmanager deployment.
2. Connect the transaction sender and confirmation poller to `SendOutcome` transitions.
3. Create a dedicated on-call response runbook tied to the alert names above.
