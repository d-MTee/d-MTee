import { verifyAttestation } from "./attestation.js";
import { isParticipantAuthorized } from "./authorization.js";

export interface RuntimePolicyInput {
  participantId?: string | null;
  attestation?: unknown;
  keyState?: string | null;
}

export interface RuntimePolicyDecision {
  allowed: boolean;
  reason: string;
}

export async function evaluateRuntimePolicy(
  input: RuntimePolicyInput,
): Promise<RuntimePolicyDecision> {
  const participantId = typeof input.participantId === "string" ? input.participantId : undefined;

  if (!isParticipantAuthorized(participantId)) {
    return { allowed: false, reason: "UNAUTHORIZED_PARTICIPANT" };
  }

  const attestation = input.attestation;
  const attestationResult = verifyAttestation(attestation);
  if (!attestationResult.ok) {
    return { allowed: false, reason: "ATTESTATION_REJECTED" };
  }

  const keyState = typeof input.keyState === "string" ? input.keyState.toUpperCase() : undefined;
  if (keyState !== "ACTIVE") {
    return { allowed: false, reason: "KEY_NOT_ACTIVE" };
  }

  return { allowed: true, reason: "ALLOW_SIGNING" };
}
