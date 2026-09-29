// Signs payloads through local hashing, MPC, or enclave-backed paths.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
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

/** Explicit fail-closed adapter until independently hosted FROST participants are connected. */
export class ThresholdSigner implements Signer {
  constructor(_unusedDemoBinary?: string) {}
  async sign(_payload: Buffer): Promise<string> {
    throw new Error("DISTRIBUTED_FROST_NOT_CONFIGURED");
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
    const publicKeyBytes = Buffer.from(result.public_key, "base64");
    if (publicKeyBytes.toString("base64") !== result.public_key || publicKeyBytes.length !== 32) throw new Error("NITRO_PUBLIC_KEY_INVALID");
    const actualPublicKey = publicKeyBytes.toString("hex");
    if (actualPublicKey !== expectedPublicKey) throw new Error("NITRO_SIGNING_KEY_MISMATCH");
    if (typeof result.signature !== "string") throw new Error("NITRO_SIGNATURE_INVALID");
    const signature = Buffer.from(result.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== result.signature) throw new Error("NITRO_SIGNATURE_INVALID");
    const verificationKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    if (!crypto.verify(null, payload, verificationKey, signature)) throw new Error("NITRO_SIGNATURE_VERIFICATION_FAILED");
    return signature.toString("hex");
  }

  static getExpectedWallet(): string {
    const rawKey = env.NITRO_EXPECTED_PUBLIC_KEY_HEX.replace(/^0x/, "");
    if (!/^[a-f0-9]{64}$/i.test(rawKey)) throw new Error("NITRO_EXPECTED_PUBLIC_KEY_NOT_CONFIGURED");
    return new PublicKey(Buffer.from(rawKey, "hex")).toBase58();
  }
}

// Backward-compatible names, now pointing at real implementations.
export const ThresholdSignerAdapter = ThresholdSigner;
export const NitroSignerAdapter = NitroSigner;
