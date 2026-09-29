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
  QUOTE_PROVIDER_RETRY_COUNT: z.coerce.number().default(2),
  QUOTE_PROVIDER_RETRY_DELAY_MS: z.coerce.number().default(150),
  QUOTE_PROVIDER_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(3),
  QUOTE_PROVIDER_CIRCUIT_BREAKER_RESET_MS: z.coerce.number().default(60000),
  TX_NONCE_MAX_AGE_MS: z.coerce.number().default(300000),
});
export const env = schema.parse(process.env);
