// Verifies that unsafe routes are rejected by the policy layer.
import test from "node:test";
import assert from "node:assert/strict";
import { checkRoute } from "../src/risk/policy.js";
import { RouteGraph } from "../src/router/graph.js";
import { createServer } from "../src/api/server.js";
import { createApproval, setApproval } from "../src/security/approval.js";
import { evaluatePreflight } from "../src/execution/simulate.js";
import { validateNonce, TransactionBuilder } from "../src/execution/builder.js";

test("risk policy rejects excessive slippage", () => {
  const r: any = {
    inputAmount: 1,
    slippageBps: 999,
    priceImpactBps: 0,
    expiresAt: Date.now() + 1000,
  };
  assert.equal(checkRoute(r).allowed, false);
});

test("risk policy rejects invalid or zero-output routes", () => {
  const r: any = {
    inputAmount: 1,
    expectedOutput: 0,
    slippageBps: 20,
    priceImpactBps: 10,
    expiresAt: Date.now() + 1000,
  };
  assert.equal(checkRoute(r).allowed, false);
  assert.ok(checkRoute(r).reasons.includes("INVALID_ROUTE"));
});

test("risk policy accepts normal route", () => {
  const r: any = {
    inputAmount: 1,
    expectedOutput: 100,
    slippageBps: 50,
    priceImpactBps: 10,
    expiresAt: Date.now() + 1000,
  };
  assert.equal(checkRoute(r).allowed, true);
});

test("risk policy rejects routes with excessive fee burn", () => {
  const r: any = {
    inputAmount: 1000,
    expectedOutput: 150,
    fees: 120,
    slippageBps: 30,
    priceImpactBps: 20,
    expiresAt: Date.now() + 1000,
  };
  assert.equal(checkRoute(r).allowed, false);
  assert.ok(checkRoute(r).reasons.includes("FEE_TOO_HIGH"));
});

test("approval creation rejects malformed trade payloads", async () => {
  await assert.rejects(() => createApproval({}), /REQUIRED_FIELDS/);
  await assert.rejects(
    () => createApproval({ id: "x", inputToken: "SOL", outputToken: "USDC" }),
    /REQUIRED_FIELDS/,
  );
});

test("execution preflight rejects overloaded or invalid simulations", () => {
  assert.equal(
    evaluatePreflight({ err: "custom", unitsConsumed: 5_000_000, priorityFeeLamports: 100_000, healthy: true }).allowed,
    false,
  );
  assert.equal(
    evaluatePreflight({ err: null, unitsConsumed: 50_000, priorityFeeLamports: 2_500, healthy: true }).allowed,
    true,
  );
});

test("api returns structured validation errors for invalid amount", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  assert.ok(address && typeof address === "object" && address.port);

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/quote?amount=NaN`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "amount must be a positive number");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve(undefined))),
    );
  }
});

test("route graph prefers lower-fee and lower-impact quotes", async () => {
  const graph = new RouteGraph([
    {
      venue: "SIM",
      quote: async () => ({
        venue: "SIM",
        inputMint: "SOL",
        outputMint: "USDC",
        inAmount: 1000,
        outAmount: 1100,
        feeBps: 100,
        priceImpactBps: 400,
        latencyMs: 40,
        timestamp: Date.now(),
      }),
    },
    {
      venue: "SIM",
      quote: async () => ({
        venue: "SIM",
        inputMint: "SOL",
        outputMint: "USDC",
        inAmount: 1000,
        outAmount: 1050,
        feeBps: 10,
        priceImpactBps: 10,
        latencyMs: 20,
        timestamp: Date.now(),
      }),
    },
  ]);

  const route = await graph.best("SOL", "USDC", 1000, 50);
  assert.equal(route.expectedOutput, 1050);
});

test("route graph ignores invalid provider quotes and falls back to a healthy quote", async () => {
  const graph = new RouteGraph([
    {
      venue: "SIM",
      quote: async () => ({
        venue: "SIM",
        inputMint: "SOL",
        outputMint: "USDC",
        inAmount: 1000,
        outAmount: NaN,
        feeBps: 0,
        priceImpactBps: 0,
        latencyMs: 10,
        timestamp: Date.now(),
      }),
    },
    {
      venue: "SIM",
      quote: async () => ({
        venue: "SIM",
        inputMint: "SOL",
        outputMint: "USDC",
        inAmount: 1000,
        outAmount: 1100,
        feeBps: 6,
        priceImpactBps: 10,
        latencyMs: 10,
        timestamp: Date.now(),
      }),
    },
  ]);

  const route = await graph.best("SOL", "USDC", 1000, 50);
  assert.equal(route.expectedOutput, 1100);
});

test("route graph marks providers unhealthy after repeated failures", async () => {
  const graph = new RouteGraph([
    {
      venue: "SIM",
      quote: async () => {
        throw new Error("provider down");
      },
    },
  ]);

  for (let i = 0; i < 3; i++) {
    await graph.best("SOL", "USDC", 1000, 50).catch(() => undefined);
  }

  assert.equal(graph.isProviderHealthy("SIM"), false);
});

test("route graph retries failing providers before failing over", async () => {
  let attempts = 0;
  const graph = new RouteGraph([
    {
      venue: "SIM",
      quote: async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("transient error");
        }
        return {
          venue: "SIM",
          inputMint: "SOL",
          outputMint: "USDC",
          inAmount: 1000,
          outAmount: 1100,
          feeBps: 6,
          priceImpactBps: 10,
          latencyMs: 10,
          timestamp: Date.now(),
        };
      },
    },
    {
      venue: "SIM",
      quote: async () => ({
        venue: "SIM",
        inputMint: "SOL",
        outputMint: "USDC",
        inAmount: 1000,
        outAmount: 1050,
        feeBps: 8,
        priceImpactBps: 12,
        latencyMs: 12,
        timestamp: Date.now(),
      }),
    },
  ]);

  const route = await graph.best("SOL", "USDC", 1000, 50);
  assert.equal(route.expectedOutput, 1100);
  assert.equal(attempts, 2);
});

test("transaction builder rejects reused or stale nonces", () => {
  assert.equal(validateNonce(0).valid, false);
  assert.equal(validateNonce(42, { previousNonce: 42 }).valid, false);
  assert.equal(validateNonce(Date.now() - 600_000, { maxAgeMs: 600_000 }).valid, false);
  assert.equal(validateNonce(123, { previousNonce: 122 }).valid, true);
});

test("transaction builder encodes a signed transaction payload with nonce and route context", () => {
  const tx = new TransactionBuilder({
    nonce: 123,
    amount: 1000,
    inputToken: "SOL",
    outputToken: "USDC",
    route: "SIM:SOL->USDC",
    previousNonce: 122,
  }).build();

  assert.equal(tx.nonce, 123);
  assert.equal(tx.route, "SIM:SOL->USDC");
  assert.equal(typeof tx.id, "string");
  assert.ok(tx.id.length > 0);
});

test("route graph penalizes stale quotes even when raw output is larger", async () => {
  const now = Date.now();
  const graph = new RouteGraph([
    {
      venue: "SIM",
      quote: async () => ({
        venue: "SIM",
        inputMint: "SOL",
        outputMint: "USDC",
        inAmount: 1000,
        outAmount: 1100,
        feeBps: 8,
        priceImpactBps: 15,
        latencyMs: 80,
        timestamp: now - 60000,
      }),
    },
    {
      venue: "SIM",
      quote: async () => ({
        venue: "SIM",
        inputMint: "SOL",
        outputMint: "USDC",
        inAmount: 1000,
        outAmount: 1000,
        feeBps: 6,
        priceImpactBps: 10,
        latencyMs: 10,
        timestamp: now,
      }),
    },
  ]);

  const route = await graph.best("SOL", "USDC", 1000, 50);
  assert.equal(route.expectedOutput, 1000);
});
