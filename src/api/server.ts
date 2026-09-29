// HTTP API for quote, policy, approval, and signing workflows.
import express from "express";
import crypto from "node:crypto";
import { redis } from "../storage/redis.js";
import { env } from "../config/env.js";
import { RouteGraph } from "../router/graph.js";
import { SimProvider } from "../quotes/simProvider.js";
import { JupiterProvider } from "../quotes/jupiter.js";
import { snapshot } from "../market/simulator.js";
import { checkRoute } from "../risk/policy.js";
import {
  simulateDevnet,
  priorityFees,
  evaluateRouteConsistency,
} from "../execution/simulate.js";
import { audit, recentAudit, verifyAuditChain } from "../audit/audit.js";
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
  attestationRejected,
  nonceRejected,
  runtimePolicyRejected,
} from "../observability/metrics.js";
import { NitroSigner } from "../security/signing.js";
import { createAttestationChallenge, verifyAttestationDocument } from "../security/attestation.js";
import { authorizeAdmin } from "../security/api-auth.js";
import { isParticipantAuthorized } from "../security/authorization.js";

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

async function verifySigningRequest(body: Record<string, any>) {
  const participantId = String(body.participantId ?? "");
  if (!isParticipantAuthorized(participantId)) throw new Error("UNAUTHORIZED_PARTICIPANT");
  if (typeof body.requestId !== "string" || body.requestId.length < 16 || body.requestId.length > 128) throw new Error("INVALID_REQUEST_ID");
  if (typeof body.approvalId !== "string" || !body.approvalId) throw new Error("APPROVAL_REQUIRED");
  if (typeof body.chainId !== "string" || !body.chainId || typeof body.walletId !== "string" || !body.walletId) throw new Error("CHAIN_AND_WALLET_REQUIRED");
  const nonce = Number(body.nonce);
  if (!Number.isSafeInteger(nonce) || nonce <= 0) { nonceRejected.inc(); throw new Error("INVALID_NONCE"); }
  if (!Number.isSafeInteger(Number(body.maxSlippageBps)) || Number(body.maxSlippageBps) <= 0 || !Number.isFinite(Number(body.amount)) || Number(body.amount) <= 0) throw new Error("INVALID_TRADE_FIELDS");
  if (typeof body.transactionMessage !== "string" || body.transactionMessage.length > 90000) throw new Error("TRANSACTION_MESSAGE_REQUIRED");
  const message = Buffer.from(body.transactionMessage, "base64");
  if (!message.length || message.toString("base64") !== body.transactionMessage) throw new Error("TRANSACTION_MESSAGE_INVALID");
  const messageHash = crypto.createHash("sha256").update(message).digest("hex");
  if (typeof body.transactionMessageHash !== "string" || body.transactionMessageHash !== messageHash) throw new Error("TRANSACTION_MESSAGE_HASH_MISMATCH");
  verifyPolicyAuthorization(body, messageHash);

  let attestation;
  try { attestation = await verifyAttestationDocument(body.attestationDocument, body.challengeId, participantId, body.requestId); }
  catch (error) { attestationRejected.inc(); runtimePolicyRejected.inc(); await audit("security.attestation.rejected", { participantId, reason: normalizeError(error) }).catch(() => {}); throw error; }
  if (attestation.participantId !== participantId) throw new Error("ATTESTATION_PARTICIPANT_MISMATCH");
  const lifecycle = await keyStatus();
  if (lifecycle.state !== "ACTIVE") throw new Error("KEY_NOT_ACTIVE");
  if (typeof body.keyId !== "string" || body.keyId !== lifecycle.keyId) throw new Error("KEY_EPOCH_MISMATCH");
  const approval = await getApproval(body.approvalId);
  if (!approval.id || approval.state !== "APPROVED") throw new Error("APPROVAL_NOT_ACTIVE");
  if (approval.transactionMessageHash !== messageHash || !approval.routeHash || approval.routeHash !== body.routeHash || !approval.policyHash || approval.policyHash !== body.policyHash) throw new Error("APPROVAL_BINDING_MISMATCH");
  if (!approval.chainId || approval.chainId !== body.chainId || !approval.walletId || approval.walletId !== body.walletId) throw new Error("APPROVAL_BINDING_MISMATCH");
  if (Number(approval.amount) !== Number(body.amount) || approval.inputToken !== body.inputToken || approval.outputToken !== body.outputToken || Number(approval.maxSlippageBps) !== Number(body.maxSlippageBps)) throw new Error("APPROVAL_BINDING_MISMATCH");
  const ttl = String(Math.ceil(env.TX_NONCE_MAX_AGE_MS / 1000));
  const claimed = await redis.eval(
    "if redis.call('HGET', KEYS[1], 'state') ~= 'APPROVED' then return -2 end; if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end; if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end; redis.call('HSET', KEYS[1], 'state', 'SIGNING', 'updatedAt', ARGV[4]); redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3]); redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3]); return 1",
    3,
    `approval:${body.approvalId}`,
    `signing:request:${body.requestId}`,
    `signing:nonce:${participantId}:${body.keyId}:${nonce}`,
    messageHash,
    body.requestId,
    ttl,
    String(Date.now()),
  );
  if (claimed !== 1) {
    if (claimed === 0) { nonceRejected.inc(); runtimePolicyRejected.inc(); throw new Error("NONCE_REUSED_OR_STALE"); }
    if (claimed === -2) throw new Error("APPROVAL_NOT_ACTIVE");
    throw new Error("REQUEST_REPLAYED");
  }
}

function verifyPolicyAuthorization(body: Record<string, any>, messageHash: string) {
  const token = body.policyAuthorization;
  const rawPublicKey = env.POLICY_AUTHORITY_PUBLIC_KEY_HEX.replace(/^0x/, "");
  if (typeof token !== "string" || token.length > 8192 || !/^[a-fA-F0-9]{64}$/.test(rawPublicKey)) throw new Error("POLICY_AUTHORIZATION_NOT_CONFIGURED");
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra !== undefined) throw new Error("POLICY_TOKEN_INVALID");
  const payload = Buffer.from(payloadPart, "base64url");
  const signature = Buffer.from(signaturePart, "base64url");
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rawPublicKey, "hex")]),
    format: "der",
    type: "spki",
  });
  if (signature.length !== 64 || !crypto.verify(null, payload, publicKey, signature)) throw new Error("POLICY_SIGNATURE_INVALID");
  const claims = JSON.parse(payload.toString("utf8"));
  const expected = {
    version: 1,
    participantId: body.participantId,
    requestId: body.requestId,
    keyId: body.keyId,
    transactionMessageHash: messageHash,
    approvalId: body.approvalId,
    routeHash: body.routeHash,
    policyHash: body.policyHash,
    chainId: body.chainId,
    walletId: body.walletId,
    amount: String(body.amount),
    inputToken: body.inputToken,
    outputToken: body.outputToken,
    maxSlippageBps: Number(body.maxSlippageBps),
  };
  if (Object.entries(expected).some(([key, value]) => claims[key] !== value)) throw new Error("POLICY_AUTHORIZATION_BINDING_MISMATCH");
  const now = Date.now();
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt < now || claims.expiresAt > now + 60_000 || typeof claims.nonce !== "string" || claims.nonce.length < 16) throw new Error("POLICY_AUTHORIZATION_EXPIRED_OR_INVALID");
}

function transactionMessageToSign(body: Record<string, any>) {
  // Solana verifies signatures over the serialized transaction message itself.
  // All approval/policy/request metadata was matched to this exact byte hash above.
  return Buffer.from(body.transactionMessage, "base64");
}

function parsePositiveNumber(value: unknown, field: string) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return n;
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

  app.post("/attestation/challenge", authorizeAdmin, async (req, res) => {
    try {
      res.json(await createAttestationChallenge(String(req.body?.participantId ?? ""), String(req.body?.requestId ?? "")));
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

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
    const startedAt = Date.now();
    try {
      const amount = parsePositiveNumber(req.query.amount ?? 10, "amount");
      const r = await graph.split("SOL", "USDC", amount, 100);
      routes.inc();
      routeLatency.observe(Date.now() - startedAt);
      res.json(r);
    } catch (error) {
      const message = normalizeError(error, "split route unavailable");
      const status = message.includes("positive number") ? 400 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.get("/route/jit", async (req, res) => {
    const startedAt = Date.now();
    try {
      const amount = parsePositiveNumber(req.query.amount ?? 10, "amount");
      const first = await graph.best("SOL", "USDC", amount, 100);
      await new Promise((r) => setTimeout(r, 50));
      const second = await graph.best("SOL", "USDC", amount, 100);
      const driftBps =
        ((first.expectedOutput - second.expectedOutput) / first.expectedOutput) *
        10000;
      routes.inc();
      routeLatency.observe(Date.now() - startedAt);
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

  app.post("/approval", authorizeAdmin, async (req, res) => {
    try {
      res.json({ id: await createApproval(req.body) });
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.get("/approval/:id", authorizeAdmin, async (req, res) => {
    try {
      res.json(await getApproval(req.params.id));
    } catch (error) {
      res.status(404).json({ error: normalizeError(error, "approval not found") });
    }
  });

  app.post("/approval/:id/:state", authorizeAdmin, async (req, res) => {
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

  app.post("/execution/validate", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const decision = evaluateRouteConsistency({
        routeOutput: Number(body.routeOutput ?? 0),
        quoteOutput: Number(body.quoteOutput ?? 0),
        simulatedOutput: Number(body.simulatedOutput ?? 0),
        priorityFeeLamports: Number(body.priorityFeeLamports ?? 0),
        expiresAt: Number(body.expiresAt ?? Date.now() + 60000),
        healthy: body.healthy ?? true,
      });
      res.json({
        allowed: decision.allowed,
        reasons: decision.reasons,
        validatedAt: Date.now(),
      });
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.get("/audit", authorizeAdmin, async (_, res) => {
    try {
      res.json(await recentAudit());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/key/status", authorizeAdmin, async (_, res) => {
    try {
      res.json(await keyStatus());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.post("/key/init", authorizeAdmin, async (_, res) => {
    try {
      res.json(await initKey());
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.post("/key/:state", authorizeAdmin, async (req, res) => {
    try {
      res.json(await transition(req.params.state.toUpperCase()));
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.post("/sign/mpc", authorizeAdmin, async (req, res) => {
    runtimePolicyRejected.inc();
    await audit("signing.rejected", { scheme: "FROST-Ed25519-2-of-3", reason: "LOCAL_MPC_DEMO_ONLY" }).catch(() => {});
    res.status(503).json({ error: "DISTRIBUTED_MPC_SIGNING_NOT_CONFIGURED", message: "The available FROST binary co-locates participants and is demo-only." });
  });

  app.post("/sign/nitro", authorizeAdmin, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      await verifySigningRequest(body);
      const payload = transactionMessageToSign(body);
      const signature = await new NitroSigner().sign(payload, body.policyAuthorization);
      await setApproval(body.approvalId, "EXECUTED");
      await audit("signing.completed", { scheme: "AWS-Nitro-Enclave-Ed25519", requestId: body.requestId, participantId: body.participantId, approvalId: body.approvalId });
      res.json({
        signature,
        scheme: "AWS-Nitro-Enclave-Ed25519",
      });
    } catch (error) {
      const reason = normalizeError(error);
      if (!reason.startsWith("ATTESTATION_") && !reason.includes("NONCE")) runtimePolicyRejected.inc();
      await audit("signing.rejected", { scheme: "AWS-Nitro-Enclave-Ed25519", reason: normalizeError(error) }).catch(() => {});
      res.status(503).json({ error: reason });
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

  app.get("/audit/verify", authorizeAdmin, async (_req, res) => {
    try { res.json(await verifyAuditChain()); }
    catch (error) { res.status(503).json({ error: normalizeError(error) }); }
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
