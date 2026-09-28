export interface AttestationRecord {
  participantId: string;
  enclaveId: string;
  nonce: string;
  pcrs?: Record<string, string>;
  signedAt?: number;
}

export interface AttestationResult {
  ok: boolean;
  errors: string[];
  participantId?: string;
  enclaveId?: string;
}

const TRUSTED_PARTICIPANTS = new Set(["p1", "p2", "p3", "coordinator"]);
const TRUSTED_ENCLAVES = new Set(["mini-dflow-enclave", "nitro-signer"]);

function hasValidPcrs(pcrs?: Record<string, string>) {
  if (!pcrs) return false;
  const pcr3 = typeof pcrs.PCR3 === "string" && pcrs.PCR3.trim().length > 0;
  const pcr8 = typeof pcrs.PCR8 === "string" && pcrs.PCR8.trim().length > 0;
  return pcr3 && pcr8;
}

export function verifyAttestation(record: unknown): AttestationResult {
  const errors: string[] = [];
  const candidate = (record ?? {}) as Partial<AttestationRecord>;

  if (!candidate.participantId || typeof candidate.participantId !== "string") {
    errors.push("participantId is required");
  } else if (!TRUSTED_PARTICIPANTS.has(candidate.participantId)) {
    errors.push("participantId is not trusted");
  }

  if (!candidate.enclaveId || typeof candidate.enclaveId !== "string") {
    errors.push("enclaveId is required");
  } else if (!TRUSTED_ENCLAVES.has(candidate.enclaveId)) {
    errors.push("enclaveId is not trusted");
  }

  if (!candidate.nonce || typeof candidate.nonce !== "string" || candidate.nonce.length < 8) {
    errors.push("nonce must be a non-empty string with at least 8 characters");
  }

  if (!hasValidPcrs(candidate.pcrs)) {
    errors.push("PCR3 and PCR8 attestation values are required");
  }

  if (typeof candidate.signedAt !== "number" || Number.isNaN(candidate.signedAt)) {
    errors.push("signedAt is required");
  }

  return {
    ok: errors.length === 0,
    errors,
    participantId: candidate.participantId,
    enclaveId: candidate.enclaveId,
  };
}
