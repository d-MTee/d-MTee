// Stores approval state for trade execution decisions.
import crypto from "node:crypto";
import { redis } from "../storage/redis.js";

export type ApprovalState = "PENDING" | "APPROVED" | "SIGNING" | "REJECTED" | "EXECUTED";

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
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
  };
}

export async function createApproval(order: unknown) {
  const payload = validateApprovalRequest(order);
  const id = payload.id;
  const fields = {
    id,
    state: "PENDING",
    inputToken: payload.inputToken,
    outputToken: payload.outputToken,
    amount: String(payload.amount),
    maxSlippageBps: String(payload.maxSlippageBps),
    routeHash: payload.routeHash ?? "",
    policyHash: payload.policyHash ?? "",
    transactionMessageHash: payload.transactionMessageHash ?? "",
    chainId: payload.chainId ?? "",
    walletId: payload.walletId ?? "",
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

export async function setApproval(id: string, state: ApprovalState) {
  const allowed: Record<ApprovalState, ApprovalState[]> = {
    PENDING: ["APPROVED", "REJECTED"],
    APPROVED: ["SIGNING", "REJECTED"],
    SIGNING: ["EXECUTED", "REJECTED"],
    REJECTED: [],
    EXECUTED: [],
  };
  if (!(state in allowed)) throw new Error("INVALID_APPROVAL_STATE");
  const changed = await redis.eval(
    "local current = redis.call('HGET', KEYS[1], 'state'); if not current then return -1 end; local allowed = cjson.decode(ARGV[1]); for _,v in ipairs(allowed) do if current == v then redis.call('HSET', KEYS[1], 'state', ARGV[2], 'updatedAt', ARGV[3]); return 1 end end; return 0",
    1,
    `approval:${id}`,
    JSON.stringify(allowed[state]),
    state,
    String(Date.now()),
  );
  if (changed !== 1) throw new Error(changed === -1 ? "APPROVAL_NOT_FOUND" : "INVALID_APPROVAL_TRANSITION");
  return redis.hgetall(`approval:${id}`);
}

export async function getApproval(id: string) {
  return redis.hgetall(`approval:${id}`);
}
