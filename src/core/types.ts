// Shared domain types for quotes, routes, and trade orders.
export type Token = "SOL" | "USDC" | string;
export type Venue =
  "JUPITER" | "ORCA" | "RAYDIUM" | "METEORA" | "PHOENIX" | "SIM";
export interface Quote {
  venue: Venue;
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  feeBps: number;
  priceImpactBps: number;
  latencyMs: number;
  slot?: number;
  route?: string[];
  raw?: unknown;
  timestamp: number;
}
export interface Leg {
  venue: Venue;
  inputToken: Token;
  outputToken: Token;
  inputAmount: number;
  outputAmount: number;
  feeBps: number;
  priceImpactBps: number;
}
export interface Route {
  legs: Leg[];
  inputAmount: number;
  expectedOutput: number;
  fees: number;
  priceImpactBps: number;
  slippageBps: number;
  priorityFeeLamports: number;
  score: number;
  expiresAt: number;
}
export interface Order {
  id: string;
  inputToken: Token;
  outputToken: Token;
  amount: number;
  maxSlippageBps: number;
  createdAt: number;
}
