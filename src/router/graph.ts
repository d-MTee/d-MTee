import type { QuoteProvider } from "../quotes/provider.js";
import type { Route, Leg, Token } from "../core/types.js";

export class RouteGraph {
  private providerHealth = new Map<string, { failures: number; unhealthyUntil: number }>();

  constructor(private providers: QuoteProvider[]) {}

  isProviderHealthy(venue: string): boolean {
    const state = this.providerHealth.get(venue);
    if (!state) {
      return true;
    }

    if (state.unhealthyUntil > Date.now()) {
      return false;
    }

    if (state.failures >= 3) {
      return false;
    }

    return true;
  }

  private markProviderFailure(provider: QuoteProvider) {
    const key = provider.venue;
    const current = this.providerHealth.get(key) ?? { failures: 0, unhealthyUntil: 0 };
    current.failures += 1;
    if (current.failures >= 3) {
      current.unhealthyUntil = Date.now() + 60_000;
    }
    this.providerHealth.set(key, current);
  }

  private markProviderSuccess(provider: QuoteProvider) {
    this.providerHealth.set(provider.venue, { failures: 0, unhealthyUntil: 0 });
  }

  private isUsableQuote(q: any): boolean {
    if (!q || typeof q !== "object") return false;
    if (!Number.isFinite(q.outAmount) || q.outAmount <= 0) return false;
    if (!Number.isFinite(q.feeBps) || q.feeBps < 0) return false;
    if (!Number.isFinite(q.priceImpactBps) || q.priceImpactBps < 0) return false;
    if (!Number.isFinite(q.latencyMs) || q.latencyMs < 0) return false;
    return typeof q.venue === "string" && typeof q.inputMint === "string" && typeof q.outputMint === "string";
  }

  async best(
    input: Token,
    output: Token,
    amount: number,
    maxSlippageBps: number,
  ): Promise<Route> {
    const healthyProviders = this.providers.filter((p) => this.isProviderHealthy(p.venue));
    if (!healthyProviders.length) {
      throw new Error("No healthy quote provider available");
    }

    const qs = await Promise.allSettled(
      healthyProviders.map(async (provider) => {
        try {
          const value = await provider.quote(input, output, amount);
          if (!this.isUsableQuote(value)) {
            this.markProviderFailure(provider);
            return null;
          }
          this.markProviderSuccess(provider);
          return value;
        } catch {
          this.markProviderFailure(provider);
          return null;
        }
      }),
    );

    const quotes = qs.flatMap((x) =>
      x.status === "fulfilled" && x.value ? [x.value] : [],
    );

    if (!quotes.length) {
      throw new Error("No healthy quote provider available");
    }

    const candidates = quotes.map((q) =>
      this.routeFrom(q, amount, maxSlippageBps),
    );

    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    return sorted[0];
  }

  async split(
    input: Token,
    output: Token,
    amount: number,
    maxSlippageBps: number,
  ): Promise<Route> {
    const parts = 10;
    let best: Route | null = null;

    for (let i = 1; i < parts; i++) {
      const a = (amount * i) / parts;
      const b = amount - a;
      const [ra, rb] = await Promise.all([
        this.best(input, output, a, maxSlippageBps),
        this.best(input, output, b, maxSlippageBps),
      ]);

      const legs = [...ra.legs, ...rb.legs];
      const expectedOutput = ra.expectedOutput + rb.expectedOutput;
      const fees = ra.fees + rb.fees;
      const route: Route = {
        legs,
        inputAmount: amount,
        expectedOutput,
        fees,
        priceImpactBps: Math.max(ra.priceImpactBps, rb.priceImpactBps),
        slippageBps: maxSlippageBps,
        priorityFeeLamports: Math.max(
          ra.priorityFeeLamports,
          rb.priorityFeeLamports,
        ),
        score: expectedOutput - fees - Math.max(ra.priceImpactBps, rb.priceImpactBps),
        expiresAt: Date.now() + 1500,
      };

      if (!best || route.score > best.score) {
        best = route;
      }
    }

    if (!best) {
      throw new Error("No split route available");
    }

    return best;
  }

  private routeFrom(q: any, amount: number, maxSlippageBps: number): Route {
    const outAmount = Number(q.outAmount);
    const feeBps = Number(q.feeBps ?? 0);
    const priceImpactBps = Number(q.priceImpactBps ?? 0);
    const latencyMs = Number(q.latencyMs ?? 0);
    const timestamp = Number(q.timestamp ?? Date.now());

    const leg: Leg = {
      venue: q.venue,
      inputToken: q.inputMint,
      outputToken: q.outputMint,
      inputAmount: amount,
      outputAmount: outAmount,
      feeBps,
      priceImpactBps,
    };

    const priorityFeeLamports = 5000;
    const feeCost = (amount * feeBps) / 10000;
    const impactPenalty = priceImpactBps * 10;
    const latencyPenalty = Math.max(0, latencyMs - 25) * 0.25;
    const freshnessMs = Date.now() - timestamp;
    const stalePenalty = freshnessMs > 5000 ? (freshnessMs - 5000) * 0.01 : 0;
    const adjustedOutput = Math.max(0, outAmount - feeCost - impactPenalty - latencyPenalty - stalePenalty);

    type DecisionReason = NonNullable<Route["decision"]>["reason"];
    let reason: DecisionReason = "best";
    if (stalePenalty > 0) reason = "stale";
    else if (q.latencyMs > 50) reason = "latency";
    else if (q.feeBps > 20) reason = "fee";
    else if (q.priceImpactBps > 50) reason = "impact";

    return {
      legs: [leg],
      inputAmount: amount,
      expectedOutput: q.outAmount,
      fees: feeCost,
      priceImpactBps: q.priceImpactBps,
      slippageBps: maxSlippageBps,
      priorityFeeLamports,
      score: adjustedOutput,
      expiresAt: Date.now() + 1500,
      decision: {
        reason,
        adjustedOutput,
        freshnessMs,
        valid: freshnessMs <= 60000,
      },
    };
  }
}
