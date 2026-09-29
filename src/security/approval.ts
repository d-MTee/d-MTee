// Stores approval state for trade execution decisions.
import crypto from "node:crypto";
import { redis } from "../storage/redis.js";

export type ApprovalState = "PENDING" | "APPROVED" | "SIGNING" | "SIGNED" | "SUBMITTING" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "REJECTED";

export interface ApprovalRequest {
  id?: string;
  inputToken: string;
  outputToken: string;
  amount: number;
  maxSlippageBps: number;
  routeHash?: string;
  policyHash?: string;
  transactionMessageHash?: string;
  chainId?: string;
  walletId?: string;
  lastValidBlockHeight?: number;
  createdAt?: number;
}

function validateApprovalRequest(order: unknown): ApprovalRequest {
  if (!order || typeof order !== "object") {
    throw new Error("REQUIRED_FIELDS");
  }

  const candidate = order as Record<string, unknown>;
  const inputToken = String(candidate.inputToken ?? "");
  const outputToken = String(candidate.outputToken ?? "");
  const amount = Number(candidate.amount);
  const maxSlippageBps = Number(candidate.maxSlippageBps);

  if (!inputToken || !outputToken || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(maxSlippageBps) || maxSlippageBps <= 0) {
    throw new Error("REQUIRED_FIELDS");
  }

  return {
    id: String(candidate.id ?? crypto.randomUUID()),
    inputToken,
    outputToken,
    amount,
    maxSlippageBps,
    routeHash: typeof candidate.routeHash === "string" ? candidate.routeHash : undefined,
    policyHash: typeof candidate.policyHash === "string" ? candidate.policyHash : undefined,
    transactionMessageHash: typeof candidate.transactionMessageHash === "string" ? candidate.transactionMessageHash : undefined,
    chainId: typeof candidate.chainId === "string" ? candidate.chainId : undefined,
    walletId: typeof candidate.walletId === "string" ? candidate.walletId : undefined,
    lastValidBlockHeight: Number.isSafeInteger(candidate.lastValidBlockHeight) ? Number(candidate.lastValidBlockHeight) : undefined,
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
  };
}

export async function createApproval(order: unknown, requesterPrincipalId: string) {
  if (!requesterPrincipalId) throw new Error("REQUESTER_ID_REQUIRED");
  const payload = validateApprovalRequest(order);
  const id = payload.id;
  const fields = {
    id,
    state: "PENDING",
    requesterPrincipalId,
    inputToken: payload.inputToken,
    outputToken: payload.outputToken,
    amount: String(payload.amount),
    maxSlippageBps: String(payload.maxSlippageBps),
    routeHash: payload.routeHash ?? "",
    policyHash: payload.policyHash ?? "",
    transactionMessageHash: payload.transactionMessageHash ?? "",
    chainId: payload.chainId ?? "",
    walletId: payload.walletId ?? "",
    lastValidBlockHeight: payload.lastValidBlockHeight === undefined ? "" : String(payload.lastValidBlockHeight),
    createdAt: String(payload.createdAt),
    order: JSON.stringify(payload),
  };
  const args = Object.entries(fields).flatMap(([key, value]) => [key, String(value)]);
  const created = await redis.eval(
    "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end; redis.call('HSET', KEYS[1], unpack(ARGV)); return 1",
    1,
    `approval:${id}`,
    ...args,
  );
  if (created !== 1) throw new Error("APPROVAL_ID_ALREADY_EXISTS");
  return id;
}

export async function setApproval(id: string, state: ApprovalState, actorPrincipalId: string) {
  if (!actorPrincipalId) throw new Error("ACTOR_ID_REQUIRED");
  const allowed: Record<ApprovalState, ApprovalState[]> = {
    PENDING: ["APPROVED", "REJECTED"],
    APPROVED: ["SIGNING", "REJECTED"],
    SIGNING: ["SIGNED", "REJECTED"],
    SIGNED: ["SUBMITTING", "REJECTED"],
    SUBMITTING: ["SUBMITTED", "FAILED"],
    SUBMITTED: ["CONFIRMED", "FAILED"],
    CONFIRMED: [],
    FAILED: [],
    REJECTED: [],
  };
  if (!(state in allowed)) throw new Error("INVALID_APPROVAL_STATE");
  const changed = await redis.eval(
    "local current = redis.call('HGET', KEYS[1], 'state'); if not current then return -1 end; if ARGV[2] == 'APPROVED' then local requester = redis.call('HGET', KEYS[1], 'requesterPrincipalId'); if not requester or requester == ARGV[4] then return -2 end end; local allowed = cjson.decode(ARGV[1]); for _,v in ipairs(allowed) do if current == v then redis.call('HSET', KEYS[1], 'state', ARGV[2], 'updatedAt', ARGV[3], 'lastActorPrincipalId', ARGV[4]); if ARGV[2] == 'APPROVED' then redis.call('HSET', KEYS[1], 'approverPrincipalId', ARGV[4]) end; return 1 end end; return 0",
    1,
    `approval:${id}`,
    JSON.stringify(allowed[state]),
    state,
    String(Date.now()),
    actorPrincipalId,
  );
  if (changed !== 1) {
    if (changed === -1) throw new Error("APPROVAL_NOT_FOUND");
    if (changed === -2) throw new Error("SELF_APPROVAL_FORBIDDEN");
    throw new Error("INVALID_APPROVAL_TRANSITION");
  }
  return redis.hgetall(`approval:${id}`);
}

export async function getApproval(id: string) {
  return redis.hgetall(`approval:${id}`);
}

export async function reserveSubmission(id: string, transactionBase64: string, messageHash: string, actorPrincipalId: string) {
  const result = await redis.eval(
    "local state = redis.call('HGET', KEYS[1], 'state'); local existing = redis.call('HGET', KEYS[1], 'executionMessageHash'); local old_tx = redis.call('HGET', KEYS[1], 'signedTransaction'); if state == 'SIGNED' then if redis.call('HGET', KEYS[1], 'transactionMessageHash') ~= ARGV[2] then return -2 end; redis.call('HSET', KEYS[1], 'state', 'SUBMITTING', 'signedTransaction', ARGV[1], 'executionMessageHash', ARGV[2], 'lastActorPrincipalId', ARGV[3], 'updatedAt', ARGV[4]); return 1 end; if (state == 'SUBMITTING' or state == 'SUBMITTED') and existing == ARGV[2] then if old_tx ~= ARGV[1] then return -3 end; if state == 'SUBMITTED' then return 2 else return 1 end end; if not state then return -1 end; return 0",
    1,
    `approval:${id}`,
    transactionBase64,
    messageHash,
    actorPrincipalId,
    String(Date.now()),
  );
  if (result === -1) throw new Error("APPROVAL_NOT_FOUND");
  if (result === -2) throw new Error("APPROVAL_BINDING_MISMATCH");
  if (result === -3) throw new Error("RETRY_TRANSACTION_MISMATCH");
  if (result === 0) throw new Error("APPROVAL_NOT_SIGNED");
  const approval = await getApproval(id);
  return { approval, alreadySubmitted: result === 2 };
}

export async function markSubmissionAccepted(id: string, signature: string) {
  const result = await redis.eval(
    "local state = redis.call('HGET', KEYS[1], 'state'); if state == 'SUBMITTED' then local old = redis.call('HGET', KEYS[1], 'transactionSignature'); if old == ARGV[1] then return 2 else return -2 end end; if state ~= 'SUBMITTING' then return 0 end; redis.call('HSET', KEYS[1], 'state', 'SUBMITTED', 'transactionSignature', ARGV[1], 'updatedAt', ARGV[2]); return 1",
    1,
    `approval:${id}`,
    signature,
    String(Date.now()),
  );
  if (result !== 1 && result !== 2) throw new Error("SUBMISSION_STATE_CONFLICT");
  return result === 2;
}

export async function markSubmissionConfirmed(id: string, signature: string) {
  const result = await redis.eval(
    "local state = redis.call('HGET', KEYS[1], 'state'); local old = redis.call('HGET', KEYS[1], 'transactionSignature'); if old ~= ARGV[1] then return -1 end; if state == 'CONFIRMED' then return 2 end; if state ~= 'SUBMITTED' then return 0 end; redis.call('HSET', KEYS[1], 'state', 'CONFIRMED', 'updatedAt', ARGV[2]); return 1",
    1,
    `approval:${id}`,
    signature,
    String(Date.now()),
  );
  if (result !== 1 && result !== 2) throw new Error("CONFIRMATION_STATE_CONFLICT");
  return result === 1;
}

export async function markSubmissionFailed(id: string, signature: string, reason: string) {
  const result = await redis.eval(
    "local old = redis.call('HGET', KEYS[1], 'transactionSignature'); if old ~= ARGV[1] then return -1 end; local state = redis.call('HGET', KEYS[1], 'state'); if state == 'FAILED' then return 2 end; if state ~= 'SUBMITTED' then return 0 end; redis.call('HSET', KEYS[1], 'state', 'FAILED', 'executionError', ARGV[2], 'updatedAt', ARGV[3]); return 1",
    1,
    `approval:${id}`,
    signature,
    reason,
    String(Date.now()),
  );
  if (result !== 1 && result !== 2) throw new Error("FAILURE_STATE_CONFLICT");
  return result === 1;
}
