const participantId = (process.env.PARTICIPANT_ID ?? '').trim().toUpperCase();
const allowed = new Set(['P1', 'P2', 'P3', 'COORDINATOR']);
const values = {
  root: process.env.NITRO_TRUSTED_ROOT_SHA256,
  pcr3: process.env[`NITRO_PCR3_${participantId}`],
  pcr4: process.env[`NITRO_PCR4_${participantId}`],
  pcr8: process.env.NITRO_PCR8,
  token: process.env.API_BEARER_TOKEN,
};

if (!allowed.has(participantId)) {
  console.error('PARTICIPANT_ID must be p1, p2, p3, or coordinator.');
  process.exit(1);
}
const validHex = (value, length) => typeof value === 'string' && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value.replaceAll(':', ''));
const missing = [];
if (!validHex(values.root, 64)) missing.push('NITRO_TRUSTED_ROOT_SHA256 (SHA-256 fingerprint, 64 hex characters)');
if (!validHex(values.pcr3, 96)) missing.push(`NITRO_PCR3_${participantId} (SHA-384 PCR3)`);
if (!validHex(values.pcr4, 96)) missing.push(`NITRO_PCR4_${participantId} (SHA-384 PCR4)`);
if (!validHex(values.pcr8, 96)) missing.push('NITRO_PCR8 (SHA-384 PCR8)');
if (typeof values.token !== 'string' || values.token.length < 32) missing.push('API_BEARER_TOKEN (32+ characters)');
if (missing.length) {
  console.error(`Fail-closed signing policy is incomplete:\n- ${missing.join('\n- ')}`);
  process.exit(1);
}
console.log(`Nitro policy configuration present for ${participantId}; this checks configuration only, not live attestation.`);
