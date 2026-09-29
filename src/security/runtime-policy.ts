import { verifyAttestation } from "./attestation.js";
import { isParticipantAuthorized } from "./authorization.js";

export interface RuntimePolicyInput {
  participantId?: string | null;
  hostId?: string | null;
  accountId?: string | null;
  attestation?: unknown;
  keyState?: string | null;
}

export interface RuntimePolicyDecision {
  allowed: boolean;
  reason: string;
}

const HOST_ALLOWLIST: Record<string, string[]> = {
  p1: ["host-p1", "participant-1", "p1-host"],
  p2: ["host-p2", "participant-2", "p2-host"],
  p3: ["host-p3", "participant-3", "p3-host"],
  coordinator: ["coordinator-host", "coordinator-node"],
};

const ACCOUNT_ALLOWLIST: Record<string, string[]> = {
  p1: ["account-p1", "participant-1"],
  p2: ["account-p2", "participant-2"],
  p3: ["account-p3", "participant-3"],
  coordinator: ["coordinator-account"],
};

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

  const hostId = typeof input.hostId === "string" ? input.hostId.trim().toLowerCase() : undefined;
  const expectedHosts = participantId ? HOST_ALLOWLIST[participantId] ?? [] : [];
  if (hostId && expectedHosts.length > 0 && !expectedHosts.includes(hostId)) {
    return { allowed: false, reason: "PARTICIPANT_HOST_MISMATCH" };
  }

  const accountId = typeof input.accountId === "string" ? input.accountId.trim().toLowerCase() : undefined;
  const expectedAccounts = participantId ? ACCOUNT_ALLOWLIST[participantId] ?? [] : [];
  if (accountId && expectedAccounts.length > 0 && !expectedAccounts.includes(accountId)) {
    return { allowed: false, reason: "PARTICIPANT_ACCOUNT_MISMATCH" };
  }

  const keyState = typeof input.keyState === "string" ? input.keyState.toUpperCase() : undefined;
  if (keyState !== "ACTIVE") {
    return { allowed: false, reason: "KEY_NOT_ACTIVE" };
  }

  return { allowed: true, reason: "ALLOW_SIGNING" };
}
