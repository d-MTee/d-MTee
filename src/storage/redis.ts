// Redis helper for short-lived market, approval, and audit state.
import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
});

export async function setJson(key: string, value: unknown, ttlSec = 300) {
  await redis.set(key, JSON.stringify(value), "EX", ttlSec);
}

export async function getJson<T>(key: string): Promise<T | null> {
  const v = await redis.get(key);
  return v ? (JSON.parse(v) as T) : null;
}
