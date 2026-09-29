import crypto from "node:crypto";
import { env } from "../config/env.js";
import { audit } from "../audit/audit.js";

type Role = "admin" | "requester" | "approver" | "signer" | "auditor";
type Credential = { id: string; principalId: string; secretHash: string; roles: Role[]; participantIds?: string[] };
type AuthRequest = { headers: Record<string, unknown>; body?: Record<string, unknown> };
type AuthResponse = { status: (n: number) => any; json: (v: unknown) => any; locals: Record<string, unknown> };

function configuredCredentials(): Credential[] | undefined {
  try {
    const parsed: unknown = JSON.parse(env.API_AUTH_TOKENS);
    if (!Array.isArray(parsed)) return undefined;
    const credentials = parsed.filter((item): item is Credential =>
      item && typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id) &&
      typeof item.principalId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(item.principalId) &&
      typeof item.secretHash === "string" && /^[a-fA-F0-9]{64}$/.test(item.secretHash) &&
      Array.isArray(item.roles) && item.roles.length > 0 &&
      item.roles.every((role: unknown) => ["admin", "requester", "approver", "signer", "auditor"].includes(String(role))) &&
      (!item.roles.includes("signer") || (Array.isArray(item.participantIds) && item.participantIds.length > 0 && item.participantIds.every((id: unknown) => typeof id === "string"))),
    );
    if (credentials.length !== parsed.length || new Set(credentials.map(({ id }) => id)).size !== credentials.length) return undefined;
    return credentials;
  } catch {
    return undefined;
  }
}

export function authorize(...allowedRoles: Role[]) {
  return (req: AuthRequest, res: AuthResponse, next: () => void) => {
    const credentials = configuredCredentials();
    if (!credentials || credentials.length === 0) {
      void audit("security.api_auth.unavailable", {}).catch(() => {});
      return res.status(503).json({ error: "API_AUTH_NOT_CONFIGURED" });
    }
    const header = req.headers.authorization;
    const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (bearer.length > 256) return res.status(401).json({ error: "UNAUTHORIZED" });
    const dot = bearer.indexOf(".");
    const id = dot > 0 ? bearer.slice(0, dot) : "";
    const secret = dot > 0 ? bearer.slice(dot + 1) : "";
    const credential = credentials.find((candidate) => candidate.id === id);
    const suppliedHash = crypto.createHash("sha256").update(secret).digest();
    const expectedHash = credential ? Buffer.from(credential.secretHash, "hex") : Buffer.alloc(32);
    const validSecret = suppliedHash.length === expectedHash.length && crypto.timingSafeEqual(suppliedHash, expectedHash);
    const permittedRole = credential && credential.roles.some((role) => role === "admin" || allowedRoles.includes(role));
    const participantId = typeof req.body?.participantId === "string" ? req.body.participantId : undefined;
    const signerScopeValid = !allowedRoles.includes("signer") || !credential?.roles.includes("signer") ||
      (participantId !== undefined && credential.participantIds?.includes(participantId) === true);
    const permitted = permittedRole && signerScopeValid;
    if (!credential || !validSecret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      void audit("security.api_auth.rejected", { credentialId: id || "unknown", requiredRoles: allowedRoles }).catch(() => {});
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    if (!permitted) {
      void audit("security.api_auth.rejected", { credentialId: id || "unknown", requiredRoles: allowedRoles }).catch(() => {});
      return res.status(403).json({ error: "FORBIDDEN" });
    }
    res.locals.authCredentialId = id;
    res.locals.authPrincipalId = credential.principalId;
    res.locals.authRoles = credential.roles;
    next();
  };
}

export const authorizeAdmin = authorize("admin");
