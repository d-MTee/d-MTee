// Stores approval state for trade execution decisions.
import crypto from "node:crypto";
import { redis } from "../storage/redis.js";

export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED";

export interface ApprovalRequest {
  id?: string;
  inputToken: string;
  outputToken: string;
  amount: number;
  maxSlippageBps: number;
  routeHash?: string;
  policyHash?: string;
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
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
  };
}

export async function createApproval(order: unknown) {
  const payload = validateApprovalRequest(order);
  const id = payload.id;
  await redis.hset(`approval:${id}`, {
    id,
    state: "PENDING",
    inputToken: payload.inputToken,
    outputToken: payload.outputToken,
    amount: String(payload.amount),
    maxSlippageBps: String(payload.maxSlippageBps),
    routeHash: payload.routeHash ?? "",
    policyHash: payload.policyHash ?? "",
    createdAt: String(payload.createdAt),
    order: JSON.stringify(payload),
  });
  return id;
}

export async function setApproval(id: string, state: ApprovalState) {
  await redis.hset(`approval:${id}`, { state });
  return redis.hgetall(`approval:${id}`);
}

export async function getApproval(id: string) {
  return redis.hgetall(`approval:${id}`);
}
