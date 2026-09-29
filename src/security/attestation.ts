import crypto from "node:crypto";
import { redis } from "../storage/redis.js";
import { env } from "../config/env.js";

type Cbor = null | boolean | number | bigint | string | Buffer | Cbor[] | Map<Cbor, Cbor>;
const participants = new Set(["p1", "p2", "p3", "coordinator"]);

/** Legacy JSON records are intentionally never trusted as Nitro evidence. */
export function verifyAttestation(_record: unknown) {
  return { ok: false, errors: ["A signed Nitro COSE attestation document is required"] };
}

// Small, bounded CBOR decoder for the Nitro COSE_Sign1 document format.
function decodeCbor(data: Buffer): Cbor {
  let offset = 0;
  function item(depth = 0): Cbor {
    if (depth > 32 || offset >= data.length) throw new Error("INVALID_CBOR");
    const initial = data[offset++];
    const major = initial >> 5;
    const ai = initial & 31;
    let length: number | bigint;
    if (ai < 24) length = ai;
    else if (ai === 24) length = data[offset++];
    else if (ai === 25) { length = data.readUInt16BE(offset); offset += 2; }
    else if (ai === 26) { length = data.readUInt32BE(offset); offset += 4; }
    else if (ai === 27) { length = data.readBigUInt64BE(offset); offset += 8; }
    else if (ai === 31 && (major === 4 || major === 5)) length = -1;
    else throw new Error("INVALID_CBOR_LENGTH");
    if (typeof length === "bigint" && length > BigInt(data.length)) throw new Error("CBOR_TOO_LARGE");
    const n = Number(length);
    if ([2, 3].includes(major)) {
      if (!Number.isSafeInteger(n) || n < 0 || offset + n > data.length) throw new Error("INVALID_CBOR_SIZE");
      const bytes = data.subarray(offset, offset + n); offset += n;
      return major === 2 ? Buffer.from(bytes) : bytes.toString("utf8");
    }
    if (major === 0) return length;
    if (major === 1) return typeof length === "bigint" ? -1n - length : -1 - n;
    if (major === 4) {
      const count = n < 0 ? -1 : n;
      if (count > 1024) throw new Error("CBOR_ARRAY_TOO_LARGE");
      const out: Cbor[] = [];
      if (count < 0) { while (data[offset] !== 0xff) out.push(item(depth + 1)); offset++; }
      else for (let i = 0; i < count; i++) out.push(item(depth + 1));
      return out;
    }
    if (major === 5) {
      const out = new Map<Cbor, Cbor>();
      const count = n < 0 ? -1 : n;
      if (count > 1024) throw new Error("CBOR_MAP_TOO_LARGE");
      if (count < 0) { while (data[offset] !== 0xff) out.set(item(depth + 1), item(depth + 1)); offset++; }
      else for (let i = 0; i < count; i++) out.set(item(depth + 1), item(depth + 1));
      return out;
    }
    if (major === 6) return item(depth + 1);
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
    }
    throw new Error("UNSUPPORTED_CBOR_TYPE");
  }
  const result = item();
  if (offset !== data.length) throw new Error("TRAILING_CBOR_DATA");
  return result;
}

function mapValue(map: Cbor, key: string): Cbor | undefined {
  return map instanceof Map ? map.get(key) : undefined;
}

function asBytes(value: Cbor | undefined, name: string): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error(`ATTESTATION_${name}_MISSING`);
  return value;
}

function verifyCertificateChain(leafDer: Buffer, bundleValue: Cbor): crypto.X509Certificate {
  if (!Array.isArray(bundleValue) || bundleValue.length === 0 || bundleValue.length > 8) throw new Error("ATTESTATION_CERT_BUNDLE_INVALID");
  const certs = [new crypto.X509Certificate(leafDer), ...bundleValue.map((x) => new crypto.X509Certificate(asBytes(x, "CERT")))];
  const pin = env.NITRO_TRUSTED_ROOT_SHA256.replaceAll(":", "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(pin)) throw new Error("NITRO_TRUSTED_ROOT_SHA256_NOT_CONFIGURED");
  const root = certs.find((cert) => cert.fingerprint256.replaceAll(":", "").toUpperCase() === pin);
  if (!root || !root.ca || !root.checkIssued(root) || !root.verify(root.publicKey)) throw new Error("ATTESTATION_ROOT_NOT_TRUSTED");
  const now = Date.now();
  for (const cert of certs) {
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) throw new Error("ATTESTATION_CERT_EXPIRED");
  }
  let current = certs[0];
  const visited = new Set<string>();
  while (current.fingerprint256 !== root.fingerprint256) {
    if (visited.has(current.fingerprint256)) throw new Error("ATTESTATION_CERT_CYCLE");
    visited.add(current.fingerprint256);
    const issuer = certs.find((candidate) => current.checkIssued(candidate) && current.issuer === candidate.subject);
    if (!issuer || !current.verify(issuer.publicKey)) throw new Error("ATTESTATION_CERT_CHAIN_INVALID");
    if (issuer.fingerprint256 !== root.fingerprint256 && !issuer.ca) throw new Error("ATTESTATION_ISSUER_NOT_CA");
    current = issuer;
  }
  return certs[0];
}

export async function createAttestationChallenge(participantId: string, requestId: string) {
  if (!participants.has(participantId)) throw new Error("UNAUTHORIZED_PARTICIPANT");
  if (requestId.length < 16 || requestId.length > 128) throw new Error("INVALID_REQUEST_ID");
  const challengeId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString("base64");
  await redis.set(`attestation:challenge:${challengeId}`, JSON.stringify({ participantId, requestId, nonce }), "EX", env.ATTESTATION_CHALLENGE_TTL_SECONDS, "NX");
  return { challengeId, nonce, requestId, userData: JSON.stringify({ participantId, requestId, challengeId }), expiresInSeconds: env.ATTESTATION_CHALLENGE_TTL_SECONDS };
}

export interface VerifiedAttestation {
  participantId: string;
  pcrs: Record<string, string>;
  timestamp: number;
  publicKey?: Buffer;
}

export async function verifyAttestationDocument(encoded: unknown, challengeId: unknown, participantId: unknown, requestId: unknown): Promise<VerifiedAttestation> {
  if (typeof encoded !== "string" || encoded.length > 256_000 || typeof challengeId !== "string" || typeof participantId !== "string" || typeof requestId !== "string") throw new Error("ATTESTATION_REQUIRED");
  const expected = await redis.get(`attestation:challenge:${challengeId}`);
  if (!expected) throw new Error("ATTESTATION_CHALLENGE_INVALID_OR_EXPIRED");
  const challenge = JSON.parse(expected) as { participantId: string; requestId: string; nonce: string };
  const nonce = challenge.nonce;
  if (challenge.participantId !== participantId || challenge.requestId !== requestId || !participants.has(participantId)) throw new Error("ATTESTATION_PARTICIPANT_MISMATCH");

  try {
    const cose = Buffer.from(encoded, "base64");
    if (!cose.length || cose.toString("base64") !== encoded) throw new Error("ATTESTATION_ENCODING_INVALID");
    const outer = decodeCbor(cose);
    if (!Array.isArray(outer) || outer.length !== 4 || !Buffer.isBuffer(outer[0]) || !Buffer.isBuffer(outer[2]) || !Buffer.isBuffer(outer[3])) throw new Error("ATTESTATION_COSE_INVALID");
    const [protectedHeader, , payload, signature] = outer as [Buffer, Cbor, Buffer, Buffer];
    const protectedMap = decodeCbor(protectedHeader);
    if (!(protectedMap instanceof Map) || protectedMap.get(1) !== -35) throw new Error("ATTESTATION_ALGORITHM_UNSUPPORTED");
    const document = decodeCbor(payload);
    if (mapValue(document, "digest") !== "SHA384") throw new Error("ATTESTATION_DIGEST_UNSUPPORTED");
    const leaf = verifyCertificateChain(asBytes(mapValue(document, "certificate"), "CERTIFICATE"), mapValue(document, "cabundle")!);
    const sigStructure = Buffer.concat([Buffer.from([0x84]), encodeCborString("Signature1"), encodeCborBytes(protectedHeader), encodeCborBytes(Buffer.alloc(0)), encodeCborBytes(payload)]);
    if (!crypto.verify("sha384", sigStructure, { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, signature)) throw new Error("ATTESTATION_SIGNATURE_INVALID");

    const timestampValue = mapValue(document, "timestamp");
    const timestamp = Number(timestampValue);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > env.ATTESTATION_MAX_AGE_MS) throw new Error("ATTESTATION_STALE");
    const docNonce = asBytes(mapValue(document, "nonce"), "NONCE");
    if (!crypto.timingSafeEqual(docNonce, Buffer.from(nonce, "base64"))) throw new Error("ATTESTATION_NONCE_MISMATCH");
    const userData = asBytes(mapValue(document, "user_data"), "USER_DATA").toString("utf8");
    if (userData !== JSON.stringify({ participantId, requestId, challengeId })) throw new Error("ATTESTATION_BINDING_MISMATCH");
    const pcrMap = mapValue(document, "pcrs");
    if (!(pcrMap instanceof Map)) throw new Error("ATTESTATION_PCRS_MISSING");
    const pcrs: Record<string, string> = {};
    for (const [key, value] of pcrMap) if (typeof key === "number" || typeof key === "bigint") {
      const pcr = asBytes(value, "PCR");
      if (pcr.length !== 48) throw new Error("ATTESTATION_PCR_LENGTH_INVALID");
      pcrs[`PCR${key}`] = pcr.toString("hex").toUpperCase();
    }
    const requiredPcr3 = env[`NITRO_PCR3_${participantId.toUpperCase()}` as "NITRO_PCR3_P1"];
    const requiredPcr4 = env[`NITRO_PCR4_${participantId.toUpperCase()}` as "NITRO_PCR4_P1"];
    const requiredPcr8 = env.NITRO_PCR8;
    if (!requiredPcr3 || !requiredPcr4 || !requiredPcr8) throw new Error("NITRO_PCR_ALLOWLIST_NOT_CONFIGURED");
    if (pcrs.PCR3 !== requiredPcr3.replaceAll(":", "").toUpperCase() || pcrs.PCR4 !== requiredPcr4.replaceAll(":", "").toUpperCase() || pcrs.PCR8 !== requiredPcr8.replaceAll(":", "").toUpperCase()) throw new Error("ATTESTATION_PCR_MISMATCH");
    const used = await redis.get(`attestation:used:${challengeId}`);
    if (used) throw new Error("ATTESTATION_REPLAYED");
    const consumed = await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]); redis.call('SET', KEYS[2], '1', 'EX', ARGV[2]); return 1 else return 0 end", 2,
      `attestation:challenge:${challengeId}`, `attestation:used:${challengeId}`, expected, String(Math.ceil(env.ATTESTATION_MAX_AGE_MS / 1000)));
    if (consumed !== 1) throw new Error("ATTESTATION_REPLAYED");
    return { participantId, pcrs, timestamp, publicKey: mapValue(document, "public_key") as Buffer | undefined };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ATTESTATION_")) throw error;
    throw new Error(`ATTESTATION_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodeCborBytes(value: Buffer) { return encodeCborStringOrBytes(value, 2); }
function encodeCborString(value: string) { return encodeCborStringOrBytes(Buffer.from(value, "utf8"), 3); }
function encodeCborStringOrBytes(value: Buffer, major: 2 | 3) {
  let header: Buffer;
  if (value.length < 24) header = Buffer.from([(major << 5) | value.length]);
  else if (value.length <= 0xff) header = Buffer.from([(major << 5) | 24, value.length]);
  else if (value.length <= 0xffff) { header = Buffer.alloc(3); header[0] = (major << 5) | 25; header.writeUInt16BE(value.length, 1); }
  else { header = Buffer.alloc(5); header[0] = (major << 5) | 26; header.writeUInt32BE(value.length, 1); }
  return Buffer.concat([header, value]);
}
