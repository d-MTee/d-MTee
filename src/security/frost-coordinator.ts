import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

export interface FrostCoordinatorInput {
  requestId: string;
  keyId: string;
  transactionMessage: Buffer;
  threshold: number;
  participantIds: string[];
  policyAuthorizations: Record<string, string>;
  expectedWallet: string;
}

export interface FrostCoordinatorResult {
  request_id: string;
  key_id: string;
  transaction_message_hash: string;
  signature_hex: string;
  group_public_key_hex: string;
  verified: boolean;
  participants: string[];
}

/** Invoke the Rust mTLS coordinator without placing tokens or payloads in argv. */
export async function distributedFrostSign(input: FrostCoordinatorInput): Promise<FrostCoordinatorResult> {
  const binary = process.env.FROST_COORDINATOR_BIN;
  if (!binary) throw new Error("FROST_COORDINATOR_NOT_CONFIGURED");
  const child = spawn(binary, ["coordinate-signing"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 32 * 1024) stdout.push(chunk);
    else child.kill();
  });
  child.stderr.on("data", () => {});
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.stdin.end(JSON.stringify({
        request_id: input.requestId,
        key_id: input.keyId,
        message_base64: input.transactionMessage.toString("base64"),
        threshold: input.threshold,
        participant_ids: input.participantIds,
        policy_authorizations: input.policyAuthorizations,
      }));
    });
    if (exit.code !== 0 || stdoutBytes > 32 * 1024) {
      // Keep provider/runtime diagnostics out of HTTP responses and audit logs.
      throw new Error(exit.signal === "SIGTERM" ? "FROST_COORDINATOR_TIMEOUT" : "FROST_COORDINATOR_FAILED");
    }
    const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as FrostCoordinatorResult;
    if (result.request_id !== input.requestId
      || result.key_id !== input.keyId
      || result.transaction_message_hash !== createHashHex(input.transactionMessage)
      || result.verified !== true
      || !/^[a-f0-9]{64}$/i.test(result.group_public_key_hex)
      || !new PublicKey(input.expectedWallet).toBuffer().equals(Buffer.from(result.group_public_key_hex, "hex"))
      || result.participants.length < input.threshold) {
      throw new Error("FROST_COORDINATOR_RESULT_BINDING_MISMATCH");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function createHashHex(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
