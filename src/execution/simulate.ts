// Simulates Solana transactions and reads recent priority-fee data.
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { env } from "../config/env.js";

export interface PreflightDecision {
  allowed: boolean;
  reasons: string[];
}

export function evaluatePreflight(input: {
  err: unknown;
  unitsConsumed?: number;
  priorityFeeLamports?: number;
  healthy?: boolean;
}): PreflightDecision {
  const reasons: string[] = [];

  if (input.err) {
    reasons.push("SIMULATION_ERROR");
  }
  if (!Number.isFinite(input.unitsConsumed) || (input.unitsConsumed ?? 0) > 200_000) {
    reasons.push("UNIT_LIMIT_EXCEEDED");
  }
  if (!Number.isFinite(input.priorityFeeLamports) || (input.priorityFeeLamports ?? 0) > 10_000) {
    reasons.push("PRIORITY_FEE_TOO_HIGH");
  }
  if (input.healthy === false) {
    reasons.push("UNHEALTHY_RPC");
  }

  return { allowed: reasons.length === 0, reasons };
}

export function evaluateRouteConsistency(input: {
  routeOutput: number;
  quoteOutput?: number;
  simulatedOutput?: number;
  priorityFeeLamports?: number;
  expiresAt?: number;
  healthy?: boolean;
}): PreflightDecision {
  const reasons: string[] = [];

  if (!Number.isFinite(input.routeOutput) || (input.routeOutput ?? 0) <= 0) {
    reasons.push("INVALID_ROUTE_OUTPUT");
  }

  if (Number.isFinite(input.quoteOutput) && (input.quoteOutput ?? 0) > 0) {
    const delta = Math.abs(input.routeOutput - input.quoteOutput);
    const ratio = delta / input.quoteOutput;
    if (ratio > 0.15) {
      reasons.push("ROUTE_OUTPUT_MISMATCH");
    }
  }

  if (Number.isFinite(input.simulatedOutput) && (input.simulatedOutput ?? 0) > 0) {
    const delta = Math.abs(input.routeOutput - input.simulatedOutput);
    const ratio = delta / Math.max(1, input.simulatedOutput);
    if (ratio > 0.2) {
      reasons.push("SIMULATION_OUTPUT_MISMATCH");
    }
  }

  if (!Number.isFinite(input.priorityFeeLamports) || (input.priorityFeeLamports ?? 0) > 10_000) {
    reasons.push("PRIORITY_FEE_TOO_HIGH");
  }

  if (Number.isFinite(input.expiresAt) && Date.now() > input.expiresAt) {
    reasons.push("QUOTE_EXPIRED");
  }

  if (input.healthy === false) {
    reasons.push("UNHEALTHY_RPC");
  }

  return { allowed: reasons.length === 0, reasons };
}

export async function simulateDevnet() {
  const c = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const payer = Keypair.generate();
  const bh = await c.getLatestBlockhash();
  const tx = new Transaction({
    recentBlockhash: bh.blockhash,
    feePayer: payer.publicKey,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 0,
    }),
  );

  const s = await (c.simulateTransaction as any)(tx, { sigVerify: false });

  const preflight = evaluatePreflight({
    err: s.value.err,
    unitsConsumed: s.value.unitsConsumed,
    priorityFeeLamports: 0,
    healthy: true,
  });

  return {
    err: s.value.err,
    logs: s.value.logs,
    units: s.value.unitsConsumed,
    blockhash: bh.blockhash,
    preflight,
  };
}

export async function priorityFees() {
  const c = new Connection(env.SOLANA_RPC_URL, "confirmed");
  return c.getRecentPrioritizationFees();
}
