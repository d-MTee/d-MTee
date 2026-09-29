import crypto from "node:crypto";
import { redis } from "../storage/redis.js";

type AuditBody = { event: string; payload: unknown; ts: string; previousHash: string; hash: string };
function digest(body: Omit<AuditBody, "hash">) {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export async function audit(event: string, payload: unknown) {
  // Optimistic compare-and-set makes concurrent writers extend one ordered chain.
  for (let attempt = 0; attempt < 20; attempt++) {
    const previousHash = (await redis.get("audit:head")) ?? "0".repeat(64);
    const unsigned = { event, payload, ts: new Date().toISOString(), previousHash };
    const hash = digest(unsigned);
    const body: AuditBody = { ...unsigned, hash };
    const result = await redis.eval(
      "if (redis.call('GET', KEYS[1]) or ARGV[1]) ~= ARGV[1] then return 0 end; redis.call('XADD', KEYS[2], '*', 'event', ARGV[2], 'payload', ARGV[3]); redis.call('SET', KEYS[1], ARGV[4]); return 1",
      2,
      "audit:head",
      "audit:events",
      previousHash,
      event,
      JSON.stringify(body),
      hash,
    );
    if (result === 1) return body;
  }
  throw new Error("AUDIT_CHAIN_CONTENTION");
}

export async function recentAudit(n = 100) {
  const rows = (await redis.xrevrange("audit:events", "+", "-", "COUNT", n)) as Array<[string, string[]]>;
  return rows.map((row) => ({
    id: row[0],
    fields: Object.fromEntries(Array.from({ length: row[1].length / 2 }, (_, i) => [row[1][i * 2], row[1][i * 2 + 1]])),
  }));
}

export async function verifyAuditChain() {
  const rows = (await redis.xrange("audit:events", "-", "+")) as Array<[string, string[]]>;
  let previousHash = "0".repeat(64);
  for (const [, fields] of rows) {
    const values = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]));
    let body: AuditBody;
    try { body = JSON.parse(values.payload); } catch { return { valid: false, entries: rows.length, reason: "INVALID_EVENT_JSON" }; }
    const { hash, ...unsigned } = body;
    if (unsigned.previousHash !== previousHash || digest(unsigned) !== hash || values.event !== body.event) return { valid: false, entries: rows.length, reason: "CHAIN_MISMATCH" };
    previousHash = hash;
  }
  const head = (await redis.get("audit:head")) ?? "0".repeat(64);
  return { valid: head === previousHash, entries: rows.length, head, reason: head === previousHash ? "OK" : "HEAD_MISMATCH" };
}
