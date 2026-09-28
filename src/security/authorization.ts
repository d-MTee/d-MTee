export const TRUSTED_PARTICIPANTS = new Set(["p1", "p2", "p3", "coordinator"]);

export function isParticipantAuthorized(participantId: string | undefined | null) {
  return typeof participantId === "string" && TRUSTED_PARTICIPANTS.has(participantId);
}
