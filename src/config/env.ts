// Runtime configuration for local and cloud deployments.
import { z } from "zod";
const schema = z.object({
  PORT: z.coerce.number().default(8080),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  JUPITER_QUOTE_URL: z.string().default("https://api.jup.ag/swap/v1/quote"),
  JUPITER_API_KEY: z.string().optional(),
  DRY_RUN: z.string().default("true"),
  MAX_ORDER_USD: z.coerce.number().default(10000),
  MAX_SLIPPAGE_BPS: z.coerce.number().default(100),
  MAX_ROUTE_DRIFT_RATIO: z.coerce.number().default(0.15),
  MAX_PRIORITY_FEE_LAMPORTS: z.coerce.number().default(10000),
  RPC_TIMEOUT_MS: z.coerce.number().default(5000),
  ENABLE_ROUTE_CONSISTENCY_GUARD: z.string().default("true"),
});
export const env = schema.parse(process.env);
