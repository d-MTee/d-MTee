// Stores approval state for trade execution decisions.
import crypto from "node:crypto";
import { redis } from "../storage/redis.js";
export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED";
export async function createApproval(order: any) {
  const id = crypto.randomUUID();
  await redis.hset(`approval:${id}`, {
    id,
    state: "PENDING",
    order: JSON.stringify(order),
    createdAt: String(Date.now()),
  });
  return id;
}
export async function setApproval(id: string, state: ApprovalState) {
  await redis.hset(`approval:${id}`, { state });
  return redis.hgetall(`approval:${id}`);
}
export async function getApproval(id: string) {
  return redis.hgetall(`approval:${id}`);
}
