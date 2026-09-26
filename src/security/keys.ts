// Tracks lifecycle state for the signing key material.
import { redis } from "../storage/redis.js";
import crypto from "node:crypto";
export async function keyStatus() {
  return redis.hgetall("key:lifecycle");
}
export async function initKey() {
  const x = await redis.hget("key:lifecycle", "keyId");
  if (!x)
    await redis.hset("key:lifecycle", {
      keyId: crypto.randomUUID(),
      state: "GENERATED",
      createdAt: String(Date.now()),
      version: "1",
    });
  return keyStatus();
}
export async function transition(state: string) {
  await redis.hset("key:lifecycle", { state, updatedAt: String(Date.now()) });
  return keyStatus();
}
