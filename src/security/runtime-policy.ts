import { verifyAttestationDocument } from "./attestation.js";

export interface RuntimePolicyInput {
  participantId?: string | null;
  /** Deprecated caller labels are ignored; PCR3/PCR4 are authoritative. */
  hostId?: string | null;
  accountId?: string | null;
  /** Deprecated JSON field is ignored and cannot satisfy Nitro verification. */
  attestation?: unknown;
  requestId?: string | null;
  challengeId?: string | null;
  attestationDocument?: string | null;
  keyState?: string | null;
}
export interface RuntimePolicyDecision { allowed: boolean; reason: string; }

/** Policy entry point intentionally accepts only a Nitro-signed document and a one-use challenge. */
export async function evaluateRuntimePolicy(input: RuntimePolicyInput): Promise<RuntimePolicyDecision> {
  if (!input.participantId || !input.challengeId || !input.attestationDocument) return { allowed: false, reason: "ATTESTATION_REQUIRED" };
  if (input.keyState !== "ACTIVE") return { allowed: false, reason: "KEY_NOT_ACTIVE" };
  try {
    if (!input.requestId) return { allowed: false, reason: "REQUEST_ID_REQUIRED" };
    const verified = await verifyAttestationDocument(input.attestationDocument, input.challengeId, input.participantId, input.requestId);
    return verified.participantId === input.participantId
      ? { allowed: true, reason: "ALLOW_SIGNING" }
      : { allowed: false, reason: "ATTESTATION_PARTICIPANT_MISMATCH" };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : "ATTESTATION_REJECTED" };
  }
}
