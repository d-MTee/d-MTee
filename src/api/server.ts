// HTTP API for quote, policy, approval, and signing workflows.
import express from "express";
import { RouteGraph } from "../router/graph.js";
import { SimProvider } from "../quotes/simProvider.js";
import { JupiterProvider } from "../quotes/jupiter.js";
import { snapshot } from "../market/simulator.js";
import { checkRoute } from "../risk/policy.js";
import { simulateDevnet, priorityFees } from "../execution/simulate.js";
import { audit, recentAudit } from "../audit/audit.js";
import {
  createApproval,
  getApproval,
  setApproval,
} from "../security/approval.js";
import { initKey, keyStatus, transition } from "../security/keys.js";
import {
  quotes,
  routes,
  routeLatency,
  registry,
} from "../observability/metrics.js";
import { ThresholdSigner, NitroSigner } from "../security/signing.js";
import { verifyAttestation } from "../security/attestation.js";
import { isParticipantAuthorized } from "../security/authorization.js";
import { evaluateRuntimePolicy } from "../security/runtime-policy.js";

const providers = [
  new SimProvider("ORCA"),
  new SimProvider("RAYDIUM"),
  new SimProvider("METEORA"),
  new SimProvider("PHOENIX"),
];
const graph = new RouteGraph(providers);

function normalizeError(error: unknown, fallback = "internal server error") {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? fallback);
}

function parsePositiveNumber(value: unknown, field: string) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return n;
}

function parseAttestation(value: unknown) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    return value;
  }
  return null;
}

async function requireTrustedAttestation(
  req: any,
  res: any,
  next: () => void,
) {
  const record = parseAttestation(req.body?.attestation ?? req.headers["x-attestation"]);
  const participantId =
    typeof req.body?.participantId === "string"
      ? req.body.participantId
      : typeof req.headers["x-participant-id"] === "string"
        ? req.headers["x-participant-id"]
        : undefined;
  const hostId =
    typeof req.body?.hostId === "string"
      ? req.body.hostId
      : typeof req.headers["x-host-id"] === "string"
        ? req.headers["x-host-id"]
        : undefined;
  const accountId =
    typeof req.body?.accountId === "string"
      ? req.body.accountId
      : typeof req.headers["x-account-id"] === "string"
        ? req.headers["x-account-id"]
        : undefined;

  if (!record) {
    return res.status(403).json({
      error: "ATTESTATION_REQUIRED",
      message: "A trusted attestation record is required for signing requests.",
    });
  }

  const keyState = typeof req.body?.keyState === "string"
    ? req.body.keyState
    : typeof req.headers["x-key-state"] === "string"
      ? req.headers["x-key-state"]
      : "ACTIVE";

  const policy = await evaluateRuntimePolicy({
    participantId,
    hostId,
    accountId,
    attestation: record,
    keyState,
  });

  if (!policy.allowed) {
    return res.status(403).json({
      error: policy.reason,
      message: policy.reason === "UNAUTHORIZED_PARTICIPANT"
        ? "The participant is not authorized to sign requests."
        : policy.reason === "ATTESTATION_REJECTED"
          ? "The attestation record is not trusted."
          : policy.reason === "KEY_NOT_ACTIVE"
            ? "The signing key is not in an active state."
            : policy.reason === "PARTICIPANT_HOST_MISMATCH"
              ? "The participant is running on an untrusted or mismatched host."
              : policy.reason === "PARTICIPANT_ACCOUNT_MISMATCH"
                ? "The participant is using an unauthorized account identity."
                : "The runtime policy rejected the request.",
    });
  }

  return next();
}

export function createServer() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.set("X-Request-Id", crypto.randomUUID());
    next();
  });

  app.get("/health", (_, res) =>
    res.json({ ok: true, service: "mini-dflow-realworld" }),
  );

  app.get("/prices", async (_, res) => {
    try {
      res.json(await snapshot());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/quote", async (req, res) => {
    const t = Date.now();
    try {
      const amount = parsePositiveNumber(req.query.amount ?? 1, "amount");
      const r = await graph.best("SOL", "USDC", amount, 100);
      quotes.inc();
      routeLatency.observe(Date.now() - t);
      res.json(r);
    } catch (error) {
      const message = normalizeError(error, "quote unavailable");
      const status = message.includes("positive number") ? 400 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.get("/route/split", async (req, res) => {
    try {
      const amount = parsePositiveNumber(req.query.amount ?? 10, "amount");
      const r = await graph.split("SOL", "USDC", amount, 100);
      routes.inc();
      res.json(r);
    } catch (error) {
      const message = normalizeError(error, "split route unavailable");
      const status = message.includes("positive number") ? 400 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.get("/route/jit", async (req, res) => {
    try {
      const amount = parsePositiveNumber(req.query.amount ?? 10, "amount");
      const first = await graph.best("SOL", "USDC", amount, 100);
      await new Promise((r) => setTimeout(r, 50));
      const second = await graph.best("SOL", "USDC", amount, 100);
      const driftBps =
        ((first.expectedOutput - second.expectedOutput) / first.expectedOutput) *
        10000;
      res.json({
        initial: first,
        rechecked: second,
        driftBps,
        accepted: driftBps <= 100,
      });
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/policy", async (req, res) => {
    try {
      const amount = parsePositiveNumber(req.query.amount ?? 10, "amount");
      const r = await graph.best("SOL", "USDC", amount, 100);
      res.json(checkRoute(r));
    } catch (error) {
      const message = normalizeError(error, "policy evaluation failed");
      const status = message.includes("positive number") ? 400 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.post("/approval", async (req, res) => {
    try {
      res.json({ id: await createApproval(req.body) });
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.get("/approval/:id", async (req, res) => {
    try {
      res.json(await getApproval(req.params.id));
    } catch (error) {
      res.status(404).json({ error: normalizeError(error, "approval not found") });
    }
  });

  app.post("/approval/:id/:state", async (req, res) => {
    try {
      res.json(
        await setApproval(req.params.id, req.params.state.toUpperCase() as any),
      );
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.get("/simulate", async (_, res) => {
    try {
      res.json(await simulateDevnet());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/priority-fees", async (_, res) => {
    try {
      res.json(await priorityFees());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/audit", async (_, res) => {
    try {
      res.json(await recentAudit());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/key/status", async (_, res) => {
    try {
      res.json(await keyStatus());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.post("/key/init", async (_, res) => {
    try {
      res.json(await initKey());
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.post("/key/:state", async (req, res) => {
    try {
      res.json(await transition(req.params.state.toUpperCase()));
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.post("/sign/mpc", requireTrustedAttestation, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const payload = Buffer.from(JSON.stringify({ ...body, attestation: undefined }));
      res.json({
        signature: await new ThresholdSigner().sign(payload),
        scheme: "FROST-Ed25519-2-of-3",
      });
    } catch (error) {
      res.status(503).json({ error: normalizeError(error) });
    }
  });

  app.post("/sign/nitro", requireTrustedAttestation, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const payload = Buffer.from(JSON.stringify({ ...body, attestation: undefined }));
      res.json({
        signature: await new NitroSigner().sign(payload),
        scheme: "AWS-Nitro-Enclave-Ed25519",
      });
    } catch (error) {
      res.status(503).json({ error: normalizeError(error) });
    }
  });

  app.get("/metrics", async (_, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      res.status(500).json({ error: normalizeError(error) });
    }
  });

  app.get("/quote/jupiter", async (req, res) => {
    try {
      const j = new JupiterProvider();
      const amount = parsePositiveNumber(req.query.amount, "amount");
      res.json(
        await j.quote(
          String(req.query.inputMint ?? "So11111111111111111111111111111111111111112"),
          String(req.query.outputMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
          amount,
        ),
      );
    } catch (error) {
      const message = normalizeError(error, "quote unavailable");
      const status = message.includes("positive number") ? 400 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.use(async (req, res, next) => {
    await audit("http.request", { method: req.method, path: req.path }).catch(
      () => {},
    );
    next();
  });

  app.use((error: any, _req: any, res: any, _next: any) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    res.status(status).json({ error: normalizeError(error, "internal server error") });
  });

  return app;
}
