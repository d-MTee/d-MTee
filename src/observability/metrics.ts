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
registry.registerMetric(quotes);
registry.registerMetric(routes);
registry.registerMetric(routeLatency);
