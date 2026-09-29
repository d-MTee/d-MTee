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
import { authorize } from "../security/api-auth.js";
import { rateLimit } from "../security/rate-limit.js";
import { isParticipantAuthorized } from "../security/authorization.js";
import { assembleApprovedTransaction, submitApprovedTransaction, transactionStatus } from "../execution/submit.js";
import { prepareJupiterTransaction } from "../execution/jupiter-build.js";

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
  if (body.chainId !== env.SOLANA_CLUSTER_ID) throw new Error("SOLANA_CLUSTER_MISMATCH");
  const nonce = Number(body.nonce);
  if (!Number.isSafeInteger(nonce) || nonce <= 0) { nonceRejected.inc(); throw new Error("INVALID_NONCE"); }
  if (!Number.isSafeInteger(Number(body.maxSlippageBps)) || Number(body.maxSlippageBps) <= 0 || !Number.isFinite(Number(body.amount)) || Number(body.amount) <= 0) throw new Error("INVALID_TRADE_FIELDS");
  if (typeof body.transactionMessage !== "string" || body.transactionMessage.length > 90000) throw new Error("TRANSACTION_MESSAGE_REQUIRED");
  const message = Buffer.from(body.transactionMessage, "base64");
  if (!message.length || message.toString("base64") !== body.transactionMessage) throw new Error("TRANSACTION_MESSAGE_INVALID");
  const messageHash = crypto.createHash("sha256").update(message).digest("hex");
  if (typeof body.transactionMessageHash !== "string" || body.transactionMessageHash !== messageHash) throw new Error("TRANSACTION_MESSAGE_HASH_MISMATCH");
  verifyPolicyAuthorization(body, messageHash);
  if (NitroSigner.getExpectedWallet() !== body.walletId) throw new Error("SIGNING_WALLET_MISMATCH");

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
  if (approval.lastValidBlockHeight && Number(approval.lastValidBlockHeight) !== Number(body.lastValidBlockHeight)) throw new Error("APPROVAL_BINDING_MISMATCH");
  if (env.ENABLE_LIVE_SUBMISSION === "true" && (!Number.isSafeInteger(Number(body.lastValidBlockHeight)) || Number(body.lastValidBlockHeight) <= 0)) throw new Error("LAST_VALID_BLOCK_HEIGHT_REQUIRED");
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
    ...(env.ENABLE_LIVE_SUBMISSION === "true" ? { lastValidBlockHeight: Number(body.lastValidBlockHeight) } : {}),
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
  app.use(express.json({ limit: "128kb" }));

  app.use((req, res, next) => {
    res.set("X-Request-Id", crypto.randomUUID());
    next();
  });

  app.get("/health", (_, res) =>
    res.json({ ok: true, service: "mini-dflow-realworld" }),
  );

  app.post("/attestation/challenge", rateLimit("attestation-challenge", 20, 60_000), authorize("signer"), async (req, res) => {
    try {
      res.json(await createAttestationChallenge(String(req.body?.participantId ?? ""), String(req.body?.requestId ?? "")));
    } catch (error) {
      await audit("attestation.challenge.rejected", { participantId: String(req.body?.participantId ?? ""), reason: normalizeError(error) }).catch(() => {});
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.get("/prices", rateLimit("prices", 120, 60_000), async (_, res) => {
    try {
      res.json(await snapshot());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/quote", rateLimit("quote", 120, 60_000), async (req, res) => {
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

  app.get("/route/split", rateLimit("route-split", 120, 60_000), async (req, res) => {
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

  app.get("/route/jit", rateLimit("route-jit", 60, 60_000), async (req, res) => {
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

  app.get("/policy", rateLimit("policy", 120, 60_000), async (req, res) => {
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

  app.post("/approval", rateLimit("approval-write", 20, 60_000), authorize("requester"), async (req, res) => {
    try {
      const requesterPrincipalId = String(res.locals.authPrincipalId ?? "");
      if (env.ENABLE_LIVE_SUBMISSION === "true" && (req.body?.chainId !== env.SOLANA_CLUSTER_ID || typeof req.body?.lastValidBlockHeight !== "number" || !Number.isSafeInteger(req.body.lastValidBlockHeight) || req.body.lastValidBlockHeight <= 0)) throw new Error("EXECUTION_EXPIRY_AND_CLUSTER_REQUIRED");
      const id = await createApproval(req.body, requesterPrincipalId);
      await audit("approval.created", { approvalId: id, requesterPrincipalId }).catch(() => {});
      res.json({ id });
    } catch (error) {
      await audit("approval.creation.rejected", { requesterPrincipalId: String(res.locals.authPrincipalId ?? ""), reason: normalizeError(error) }).catch(() => {});
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.get("/approval/:id", rateLimit("approval-read", 60, 60_000), authorize("requester", "approver", "auditor"), async (req, res) => {
    try {
      res.json(await getApproval(String(req.params.id)));
    } catch (error) {
      res.status(404).json({ error: normalizeError(error, "approval not found") });
    }
  });

  app.post("/approval/:id/:state", rateLimit("approval-write", 20, 60_000), authorize("approver"), async (req, res) => {
    try {
      const actorPrincipalId = String(res.locals.authPrincipalId ?? "");
      const state = String(req.params.state).toUpperCase();
      if (state !== "APPROVED" && state !== "REJECTED") throw new Error("INVALID_APPROVAL_STATE");
      const approval = await setApproval(String(req.params.id), state, actorPrincipalId);
      await audit("approval.transitioned", { approvalId: String(req.params.id), state: approval.state, actorPrincipalId }).catch(() => {});
      res.json(approval);
    } catch (error) {
      await audit("approval.transition.rejected", { approvalId: String(req.params.id), actorPrincipalId: String(res.locals.authPrincipalId ?? ""), reason: normalizeError(error) }).catch(() => {});
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.get("/simulate", rateLimit("simulation", 30, 60_000), async (_, res) => {
    try {
      res.json(await simulateDevnet());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/priority-fees", rateLimit("priority-fees", 60, 60_000), async (_, res) => {
    try {
      res.json(await priorityFees());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.post("/execution/validate", rateLimit("execution-validate", 60, 60_000), async (req, res) => {
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

  app.post("/execution/prepare", rateLimit("execution-prepare", 10, 60_000), authorize("requester"), async (req, res) => {
    try {
      if (env.SOLANA_CLUSTER_ID === "solana-mainnet-beta") throw new Error("MAINNET_REQUIRES_DISTRIBUTED_FROST");
      const body: Record<string, any> = req.body && typeof req.body === "object" ? req.body : {};
      const amount = Number(body.amount);
      const maxSlippageBps = Number(body.maxSlippageBps);
      const prepared = await prepareJupiterTransaction({
        inputMint: String(body.inputMint ?? ""),
        outputMint: String(body.outputMint ?? ""),
        amount,
        slippageBps: maxSlippageBps,
        wallet: NitroSigner.getExpectedWallet(),
      });
      const requesterPrincipalId = String(res.locals.authPrincipalId ?? "");
      const approvalId = await createApproval({
        inputToken: prepared.inputMint,
        outputToken: prepared.outputMint,
        amount: prepared.amount,
        maxSlippageBps: prepared.maxSlippageBps,
        routeHash: prepared.routeHash,
        policyHash: prepared.policyHash,
        transactionMessageHash: prepared.transactionMessageHash,
        chainId: prepared.chainId,
        walletId: prepared.walletId,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      }, requesterPrincipalId);
      await audit("execution.prepared", { approvalId, requesterPrincipalId, transactionMessageHash: prepared.transactionMessageHash, chainId: prepared.chainId }).catch(() => {});
      res.status(201).json({ approvalId, ...prepared });
    } catch (error) {
      const reason = normalizeError(error);
      await audit("execution.prepare.rejected", { requesterPrincipalId: String(res.locals.authPrincipalId ?? ""), reason }).catch(() => {});
      res.status(reason === "MAINNET_REQUIRES_DISTRIBUTED_FROST" ? 503 : 400).json({ error: reason });
    }
  });

  app.get("/audit", rateLimit("audit-read", 60, 60_000), authorize("auditor"), async (_, res) => {
    try {
      res.json(await recentAudit());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.get("/key/status", rateLimit("key-status", 60, 60_000), authorize("auditor"), async (_, res) => {
    try {
      res.json(await keyStatus());
    } catch (error) {
      res.status(502).json({ error: normalizeError(error) });
    }
  });

  app.post("/key/init", rateLimit("key-init", 5, 60_000), authorize("admin"), async (_, res) => {
    try {
      res.json(await initKey());
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.post("/key/:state", rateLimit("key-transition", 10, 60_000), authorize("admin"), async (req, res) => {
    try {
      res.json(await transition(String(req.params.state).toUpperCase()));
    } catch (error) {
      res.status(400).json({ error: normalizeError(error) });
    }
  });

  app.post("/sign/mpc", rateLimit("signing", 10, 60_000), authorize("signer"), async (req, res) => {
    runtimePolicyRejected.inc();
    await audit("signing.rejected", { scheme: "FROST-Ed25519-2-of-3", reason: "LOCAL_MPC_DEMO_ONLY" }).catch(() => {});
    res.status(503).json({ error: "DISTRIBUTED_MPC_SIGNING_NOT_CONFIGURED", message: "The available FROST binary co-locates participants and is demo-only." });
  });

  app.post("/sign/nitro", rateLimit("signing", 10, 60_000), authorize("signer"), async (req, res) => {
    try {
      const body: Record<string, any> = req.body && typeof req.body === "object" ? req.body : {};
      await verifySigningRequest(body);
      const payload = transactionMessageToSign(body);
      const signature = await new NitroSigner().sign(payload, body.policyAuthorization);
      await setApproval(body.approvalId, "SIGNED", `nitro:${String(body.participantId)}`);
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

  app.post("/execution/submit", rateLimit("execution-submit", 5, 60_000), authorize("signer"), async (req, res) => {
    try {
      if (env.ENABLE_LIVE_SUBMISSION !== "true") throw new Error("LIVE_SUBMISSION_DISABLED");
      if (env.DRY_RUN !== "false") throw new Error("DRY_RUN_MUST_BE_DISABLED_FOR_SUBMISSION");
      if (env.SOLANA_CLUSTER_ID === "solana-mainnet-beta") throw new Error("MAINNET_REQUIRES_DISTRIBUTED_FROST");
      const body: Record<string, any> = req.body && typeof req.body === "object" ? req.body : {};
      const participantId = String(body.participantId ?? "");
      if (!isParticipantAuthorized(participantId)) throw new Error("UNAUTHORIZED_PARTICIPANT");
      const approvalId = String(body.approvalId ?? "");
      const approval = await getApproval(approvalId);
      if (!approval.id || (approval.state !== "SIGNED" && approval.state !== "SUBMITTING")) throw new Error("APPROVAL_NOT_SIGNED");
      if (approval.chainId !== env.SOLANA_CLUSTER_ID) throw new Error("SOLANA_CLUSTER_MISMATCH");
      const expectedWallet = String(approval.walletId ?? "");
      const lastValidBlockHeight = Number(approval.lastValidBlockHeight);
      const result = await submitApprovedTransaction({
        approvalId,
        serializedTransaction: body.serializedTransaction,
        expectedMessageHash: approval.transactionMessageHash,
        expectedWallet,
        lastValidBlockHeight,
        actorPrincipalId: String(res.locals.authPrincipalId ?? ""),
      });
      await audit("execution.submitted", { approvalId, participantId, signature: result.signature, confirmed: result.confirmed, cluster: env.SOLANA_CLUSTER_ID }).catch(() => {});
      res.status(202).json({ approvalId, ...result, cluster: env.SOLANA_CLUSTER_ID });
    } catch (error) {
      const reason = normalizeError(error);
      await audit("execution.rejected", { approvalId: String(req.body?.approvalId ?? ""), reason }).catch(() => {});
      res.status(reason === "LIVE_SUBMISSION_DISABLED" ? 503 : 400).json({ error: reason });
    }
  });

  app.post("/execution/assemble", rateLimit("execution-assemble", 10, 60_000), authorize("signer"), async (req, res) => {
    try {
      const body: Record<string, any> = req.body && typeof req.body === "object" ? req.body : {};
      const participantId = String(body.participantId ?? "");
      if (!isParticipantAuthorized(participantId)) throw new Error("UNAUTHORIZED_PARTICIPANT");
      const approvalId = String(body.approvalId ?? "");
      const approval = await getApproval(approvalId);
      if (!approval.id || approval.state !== "SIGNED") throw new Error("APPROVAL_NOT_SIGNED");
      if (approval.chainId !== env.SOLANA_CLUSTER_ID) throw new Error("SOLANA_CLUSTER_MISMATCH");
      const result = assembleApprovedTransaction({
        unsignedTransaction: body.unsignedTransaction,
        signatureHex: body.signature,
        expectedMessageHash: approval.transactionMessageHash,
        expectedWallet: approval.walletId,
      });
      await audit("execution.signature_attached", { approvalId, participantId, transactionMessageHash: result.transactionMessageHash }).catch(() => {});
      res.json({ approvalId, ...result });
    } catch (error) {
      const reason = normalizeError(error);
      await audit("execution.assembly_rejected", { approvalId: String(req.body?.approvalId ?? ""), reason }).catch(() => {});
      res.status(400).json({ error: reason });
    }
  });

  app.get("/execution/:approvalId", rateLimit("execution-status", 30, 60_000), authorize("requester", "approver", "auditor"), async (req, res) => {
    try {
      const approval = await getApproval(String(req.params.approvalId));
      if (!approval.id) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
      const principalId = String(res.locals.authPrincipalId ?? "");
      const roles = Array.isArray(res.locals.authRoles) ? res.locals.authRoles as string[] : [];
      if (!roles.includes("admin") && !roles.includes("auditor") && principalId !== approval.requesterPrincipalId && principalId !== approval.approverPrincipalId) return res.status(403).json({ error: "FORBIDDEN" });
      if (approval.chainId !== env.SOLANA_CLUSTER_ID) return res.status(409).json({ error: "SOLANA_CLUSTER_MISMATCH" });
      res.json(await transactionStatus(approval));
    } catch (error) {
      res.status(503).json({ error: normalizeError(error) });
    }
  });

  app.get("/metrics", rateLimit("metrics", 30, 60_000), authorize("auditor"), async (_, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      res.status(500).json({ error: normalizeError(error) });
    }
  });

  app.get("/quote/jupiter", rateLimit("jupiter-quote", 60, 60_000), async (req, res) => {
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

  app.get("/audit/verify", rateLimit("audit-verify", 10, 60_000), authorize("auditor"), async (_req, res) => {
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
