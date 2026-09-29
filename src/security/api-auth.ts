import crypto from "node:crypto";
import { env } from "../config/env.js";
import { audit } from "../audit/audit.js";

export function authorizeAdmin(req: { headers: Record<string, unknown> }, res: { status: (n: number) => any; json: (v: unknown) => any }, next: () => void) {
  const expected = env.API_BEARER_TOKEN;
  if (!expected || expected.length < 32 || expected.startsWith("replace-with-")) {
    void audit("security.api_auth.unavailable", {}).catch(() => {});
    return res.status(503).json({ error: "API_AUTH_NOT_CONFIGURED" });
  }
  const header = req.headers.authorization;
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    void audit("security.api_auth.rejected", {}).catch(() => {});
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  next();
}
