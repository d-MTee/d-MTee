import { env } from "../config/env.js";
import { txSubmitted, txConfirmed, txFailed } from "../observability/metrics.js";

export interface SendRequest {
  id?: string;
  nonce?: number | string;
  route?: string;
  signer?: string;
  amount?: number;
  maxSlippageBps?: number;
  approvals?: string[];
  rpcUrl?: string;
}

export interface SendPlan {
  id: string;
  nonce: number;
  route: string;
  signer: string;
  amount: number;
  maxSlippageBps: number;
  approvals: string[];
  rpcUrl: string;
  createdAt: number;
}

export interface SendOutcome {
  id: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  txSignature?: string;
  nonce: number;
  createdAt: number;
  updatedAt: number;
  reason?: string;
}

export function validateSendRequest(input: SendRequest): SendPlan {
  const nonce = Number(input.nonce ?? 0);
  if (!Number.isInteger(nonce) || nonce <= 0) {
    throw new Error("INVALID_NONCE");
  }

  const amount = Number(input.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  const route = typeof input.route === "string" && input.route.trim().length > 0
    ? input.route.trim()
    : "unknown";

  const signer = typeof input.signer === "string" && input.signer.trim().length > 0
    ? input.signer.trim()
    : "unknown-signer";

  const rpcUrl = typeof input.rpcUrl === "string" && input.rpcUrl.trim().length > 0
    ? input.rpcUrl.trim()
    : env.SOLANA_RPC_URL;

  const maxSlippageBps = Number(input.maxSlippageBps ?? env.MAX_SLIPPAGE_BPS ?? 100);

  return {
    id: input.id ?? `tx-${Date.now()}-${nonce}`,
    nonce,
    route,
    signer,
    amount,
    maxSlippageBps,
    approvals: Array.isArray(input.approvals) ? input.approvals : [],
    rpcUrl,
    createdAt: Date.now(),
  };
}

export function createSendOutcome(plan: SendPlan, status: SendOutcome["status"], txSignature?: string, reason?: string): SendOutcome {
  if (status === "submitted") txSubmitted.inc();
  if (status === "confirmed") txConfirmed.inc();
  if (status === "failed") txFailed.inc();
  const now = Date.now();
  return {
    id: plan.id,
    status,
    txSignature,
    nonce: plan.nonce,
    createdAt: plan.createdAt,
    updatedAt: now,
    reason,
  };
}

export function getSendCircuitPolicy() {
  return {
    retryCount: Number(env.QUOTE_PROVIDER_RETRY_COUNT ?? 2),
    retryDelayMs: Number(env.QUOTE_PROVIDER_RETRY_DELAY_MS ?? 150),
    timeoutMs: Number(env.RPC_TIMEOUT_MS ?? 5000),
    maxAgeMs: Number(env.TX_NONCE_MAX_AGE_MS ?? 300000),
  };
}
