// Tracks lifecycle state for the signing key material.
import { redis } from "../storage/redis.js";
import crypto from "node:crypto";
import { audit } from "../audit/audit.js";

export type KeyState =
  | "GENERATED"
  | "ACTIVE"
  | "ROTATING"
  | "REVOKED"
  | "DECOMMISSIONED";

const VALID_TRANSITIONS: Record<KeyState, KeyState[]> = {
  GENERATED: ["ACTIVE"],
  ACTIVE: ["ROTATING", "REVOKED", "DECOMMISSIONED"],
  ROTATING: ["ACTIVE", "REVOKED"],
  REVOKED: [],
  DECOMMISSIONED: [],
};

export function isValidKeyTransition(from: string, to: string): boolean {
  const src = from as KeyState;
  const dst = to as KeyState;
  if (!Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, src)) return false;
  if (!Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, dst)) return false;
  return VALID_TRANSITIONS[src].includes(dst);
}

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
  const current = String((await redis.hget("key:lifecycle", "state")) ?? "GENERATED");
  if (!isValidKeyTransition(current, state)) {
    const error = `INVALID_KEY_TRANSITION:${current}->${state}`;
    await audit("key.transition.rejected", { from: current, to: state, error }).catch(() => {});
    throw new Error(error);
  }
  await redis.hset("key:lifecycle", { state, updatedAt: String(Date.now()) });
  await audit("key.transition.accepted", { from: current, to: state, updatedAt: Date.now() }).catch(() => {});
  return keyStatus();
}
