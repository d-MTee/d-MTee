// Signs payloads through local hashing, MPC, or enclave-backed paths.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { env } from "../config/env.js";
const exec = promisify(execFile);

export interface Signer {
  sign(payload: Buffer, authorization?: string): Promise<string>;
}

export class LocalSigner implements Signer {
  async sign(payload: Buffer, _authorization?: string) {
    return crypto.createHash("sha256").update(payload).digest("hex");
  }
}

/** Real FROST signer adapter. The Rust binary performs RFC 9591 DKG + 2-of-3 signing. */
export class ThresholdSigner implements Signer {
  constructor(
    private readonly binary = process.env.MPC_BIN ??
      "mpc/frost-signer/target/release/dflow-frost-signer",
  ) {}
  async sign(payload: Buffer) {
    const { stdout } = await exec(
      this.binary,
      ["demo", payload.toString("base64")],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    if (!result.verified || !result.signature)
      throw new Error("MPC_SIGNATURE_VERIFICATION_FAILED");
    return result.signature;
  }
}

/** Real Nitro adapter: calls a parent-side VSock client, which reaches the enclave. */
export class NitroSigner implements Signer {
  constructor(
    private readonly client = process.env.NITRO_VSOCK_CLIENT ??
      "nitro/parent/vsock_client.py",
  ) {}
  async sign(payload: Buffer, authorization?: string) {
    if (!authorization) throw new Error("POLICY_AUTHORIZATION_REQUIRED");
    const b64 = payload.toString("base64");
    const { stdout } = await exec(
      process.env.PYTHON_BIN ?? "python3",
      [this.client, "sign", b64, "", "", authorization],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    if (!result.ok || !result.signature)
      throw new Error(result.error ?? "NITRO_SIGN_FAILED");
    const expectedPublicKey = env.NITRO_EXPECTED_PUBLIC_KEY_HEX.replace(/^0x/, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedPublicKey) || typeof result.public_key !== "string")
      throw new Error("NITRO_EXPECTED_PUBLIC_KEY_NOT_CONFIGURED");
    const actualPublicKey = Buffer.from(result.public_key, "base64").toString("hex");
    if (actualPublicKey !== expectedPublicKey) throw new Error("NITRO_SIGNING_KEY_MISMATCH");
    return Buffer.from(result.signature, "base64").toString("hex");
  }
}

// Backward-compatible names, now pointing at real implementations.
export const ThresholdSignerAdapter = ThresholdSigner;
export const NitroSignerAdapter = NitroSigner;
