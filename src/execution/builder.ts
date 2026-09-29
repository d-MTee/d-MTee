import { env } from "../config/env.js";

export interface NonceValidationOptions {
  previousNonce?: number;
  maxAgeMs?: number;
  now?: number;
}

export interface NonceValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateNonce(
  nonce: number | string | undefined,
  options: NonceValidationOptions = {},
): NonceValidationResult {
  const numericNonce = Number(nonce);
  if (!Number.isFinite(numericNonce) || !Number.isInteger(numericNonce) || numericNonce <= 0) {
    return { valid: false, reason: "INVALID_NONCE" };
  }

  if (
    typeof options.previousNonce === "number" &&
    Number.isFinite(options.previousNonce) &&
    numericNonce <= options.previousNonce
  ) {
    return { valid: false, reason: "NONCE_REUSED_OR_STALE" };
  }

  const now = typeof options.now === "number" ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Number(options.maxAgeMs)
    : Number(env.TX_NONCE_MAX_AGE_MS ?? 300_000);

  if (numericNonce > 1_000_000_000 && now - numericNonce >= maxAgeMs) {
    return { valid: false, reason: "NONCE_EXPIRED" };
  }

  return { valid: true };
}

export interface TransactionBuildInput {
  nonce: number | string;
  previousNonce?: number;
  amount: number;
  inputToken: string;
  outputToken: string;
  route: string;
  createdAt?: number;
}

export class TransactionBuilder {
  constructor(private readonly input: TransactionBuildInput) {}

  build() {
    const nonceValue = Number(this.input.nonce);
    const validation = validateNonce(nonceValue, {
      previousNonce: this.input.previousNonce,
      maxAgeMs: Number(env.TX_NONCE_MAX_AGE_MS ?? 300_000),
    });

    if (!validation.valid) {
      throw new Error(validation.reason ?? "INVALID_NONCE");
    }

    const createdAt = this.input.createdAt ?? Date.now();

    return {
      id: crypto.randomUUID(),
      nonce: nonceValue,
      amount: this.input.amount,
      inputToken: this.input.inputToken,
      outputToken: this.input.outputToken,
      route: this.input.route,
      createdAt,
    };
  }
}
