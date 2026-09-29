// Exposes counters and latency metrics for route and quote telemetry.
import client from "prom-client";
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
export const quotes = new client.Counter({
  name: "dflow_quotes_total",
  help: "quotes",
});
export const routes = new client.Counter({
  name: "dflow_routes_total",
  help: "routes",
});
export const routeLatency = new client.Histogram({
  name: "dflow_route_latency_ms",
  help: "route latency",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
});
export const providerFailures = new client.Counter({ name: "dflow_provider_failures_total", help: "Quote provider failures", labelNames: ["venue"] });
export const providerCircuitOpen = new client.Counter({ name: "dflow_provider_circuit_open_total", help: "Quote provider circuit openings", labelNames: ["venue"] });
export const txSubmitted = new client.Counter({ name: "dflow_tx_submitted_total", help: "Transactions submitted" });
export const txConfirmed = new client.Counter({ name: "dflow_tx_confirmed_total", help: "Transactions confirmed" });
export const txFailed = new client.Counter({ name: "dflow_tx_failed_total", help: "Transaction attempts marked failed" });
export const nonceRejected = new client.Counter({ name: "dflow_nonce_rejected_total", help: "Signing or execution nonces rejected" });
export const attestationRejected = new client.Counter({ name: "dflow_attestation_rejected_total", help: "Nitro attestations rejected" });
export const runtimePolicyRejected = new client.Counter({ name: "dflow_runtime_policy_rejected_total", help: "Runtime policy rejections" });
registry.registerMetric(quotes);
registry.registerMetric(routes);
registry.registerMetric(routeLatency);
for (const metric of [providerFailures, providerCircuitOpen, txSubmitted, txConfirmed, txFailed, nonceRejected, attestationRejected, runtimePolicyRejected]) registry.registerMetric(metric);
