// Produces simulated market prices used by quote providers.
import { redis, setJson } from "../storage/redis.js";
const venues = [
  ["ORCA", 150],
  ["RAYDIUM", 149.7],
  ["METEORA", 150.2],
  ["PHOENIX", 149.9],
] as const;
export function startMarketSimulator() {
  setInterval(async () => {
    for (const [v, p] of venues) {
      const mid = p * (1 + (Math.random() - 0.5) * 0.002);
      await setJson(`market:${v}:SOLUSDC`, {
        venue: v,
        mid,
        timestamp: Date.now(),
      });
    }
  }, 100);
}
export async function snapshot() {
  const out: any[] = [];
  for (const [v] of venues) {
    const x = await redis.get(`market:${v}:SOLUSDC`);
    if (x) out.push(JSON.parse(x));
  }
  return out;
}
