// Simulated market quotes for local routing and testing.
import { redis } from "../storage/redis.js";
import type { QuoteProvider } from "./provider.js";
import type { Quote, Token, Venue } from "../core/types.js";
export class SimProvider implements QuoteProvider {
  constructor(public readonly venue: Venue) {}
  async quote(input: Token, output: Token, amount: number): Promise<Quote> {
    const x = await redis.get(`market:${this.venue}:SOLUSDC`);
    const mid = x ? JSON.parse(x).mid : 150;
    const feeBps = 8 + Math.random() * 8;
    const impactBps = Math.min(80, (amount / 10000) * 40);
    const out = amount * mid * (1 - feeBps / 10000 - impactBps / 10000);
    return {
      venue: this.venue,
      inputMint: input,
      outputMint: output,
      inAmount: amount,
      outAmount: out,
      feeBps,
      priceImpactBps: impactBps,
      latencyMs: 1 + Math.random() * 3,
      timestamp: Date.now(),
    };
  }
}
