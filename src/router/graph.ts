import type { QuoteProvider } from "../quotes/provider.js";
import type { Route, Leg, Token } from "../core/types.js";

export class RouteGraph {
  constructor(private providers: QuoteProvider[]) {}

  async best(
    input: Token,
    output: Token,
    amount: number,
    maxSlippageBps: number,
  ): Promise<Route> {
    const qs = await Promise.allSettled(
      this.providers.map((p) => p.quote(input, output, amount)),
    );

    const quotes = qs.flatMap((x) =>
      x.status === "fulfilled" ? [x.value] : [],
    );

    if (!quotes.length) {
      throw new Error("No quote provider available");
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
    const leg: Leg = {
      venue: q.venue,
      inputToken: q.inputMint,
      outputToken: q.outputMint,
      inputAmount: amount,
      outputAmount: q.outAmount,
      feeBps: q.feeBps,
      priceImpactBps: q.priceImpactBps,
    };

    const priorityFeeLamports = 5000;
    const feeCost = (amount * q.feeBps) / 10000;
    const impactPenalty = q.priceImpactBps * 10;
    const latencyPenalty = Math.max(0, (q.latencyMs ?? 0) - 25) * 0.25;
    const freshnessMs = Date.now() - (q.timestamp ?? Date.now());
    const stalePenalty = freshnessMs > 5000 ? (freshnessMs - 5000) * 0.01 : 0;
    const adjustedOutput = Math.max(0, q.outAmount - feeCost - impactPenalty - latencyPenalty - stalePenalty);

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
