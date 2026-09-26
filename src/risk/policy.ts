// Enforces basic trade safety rules before acceptance.
import { env } from "../config/env.js";
import type { Route } from "../core/types.js";

export interface Decision {
  allowed: boolean;
  reasons: string[];
}

export function checkRoute(r: Route): Decision {
  const reasons: string[] = [];

  if (!Number.isFinite(r.inputAmount) || r.inputAmount <= 0) {
    reasons.push("INVALID_INPUT");
  }
  if (!Number.isFinite(r.expectedOutput) || r.expectedOutput <= 0) {
    reasons.push("INVALID_ROUTE");
  }
  if (r.inputAmount > env.MAX_ORDER_USD) {
    reasons.push("MAX_ORDER");
  }
  if (r.slippageBps > env.MAX_SLIPPAGE_BPS) {
    reasons.push("SLIPPAGE");
  }
  if (Date.now() > r.expiresAt) {
    reasons.push("QUOTE_EXPIRED");
  }
  if (r.priceImpactBps > env.MAX_SLIPPAGE_BPS) {
    reasons.push("PRICE_IMPACT");
  }

  return { allowed: reasons.length === 0, reasons };
}
