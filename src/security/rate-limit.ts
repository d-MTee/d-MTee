import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { redis } from "../storage/redis.js";
import { rateLimitRejected, rateLimitStorageErrors } from "../observability/metrics.js";

const WINDOW_SCRIPT = "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return {n, redis.call('PTTL', KEYS[1])}";

export function rateLimit(bucket: string, limit: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Express trust-proxy is left disabled by default; only use the socket-derived IP.
    const address = req.socket.remoteAddress ?? req.ip ?? "unknown";
    const addressDigest = crypto.createHash("sha256").update(address).digest("hex");
    const key = `http-rate:${bucket}:${addressDigest}`;
    try {
      const result = await redis.eval(WINDOW_SCRIPT, 1, key, String(windowMs)) as [number | string, number | string];
      const count = Number(result[0]);
      const ttl = Number(result[1]);
      if (count > limit) {
        rateLimitRejected.labels(bucket).inc();
        res.set("Retry-After", String(Math.max(1, Math.ceil(ttl / 1000))));
        return res.status(429).json({ error: "RATE_LIMITED" });
      }
      next();
    } catch {
      rateLimitStorageErrors.labels(bucket).inc();
      return res.status(503).json({ error: "RATE_LIMIT_STORAGE_UNAVAILABLE" });
    }
  };
}
