import { createHash, randomBytes } from "node:crypto";

const [id, role, participantId, principalId = id] = process.argv.slice(2);
const roles = new Set(["admin", "requester", "approver", "signer", "auditor"]);
if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !principalId || !/^[a-zA-Z0-9_-]{1,64}$/.test(principalId) || !roles.has(role) || (role === "signer" && (!participantId || participantId === "-"))) {
  console.error("Usage: node scripts/generate-api-credential.mjs <id> <admin|requester|approver|signer|auditor> [participantId|-] [principalId]");
  process.exit(2);
}

const secret = randomBytes(32).toString("base64url");
const credential = {
  id,
  principalId,
  secretHash: createHash("sha256").update(secret).digest("hex"),
  roles: [role],
  ...(role === "signer" ? { participantIds: [participantId] } : {}),
};
console.log(JSON.stringify({ bearerToken: `${id}.${secret}`, credential }));
