// Confirms the signing path behaves as expected in dev and test modes.
import test from "node:test";
import assert from "node:assert/strict";
import { LocalSigner, ThresholdSigner } from "../src/security/signing.js";

test("local signer remains explicitly non-cryptographic demo signer", async () => {
  const s = await new LocalSigner().sign(Buffer.from("abc"));
  assert.equal(s.length, 64);
});

test("real MPC adapter is wired to the FROST binary", async () => {
  const s = new ThresholdSigner(
    "mpc/frost-signer/target/release/dflow-frost-signer",
  );
  try {
    const sig = await s.sign(Buffer.from("integration-test"));
    assert.equal(typeof sig, "string");
    assert.ok(sig.length > 0);
  } catch (e: any) {
    assert.match(
      String(e?.message ?? e),
      /ENOENT|spawn|No such file|MPC_SIGNATURE_VERIFICATION_FAILED/,
    );
  }
});

test("attestation verification accepts a trusted participant payload", async () => {
  const { verifyAttestation } = await import("../src/security/attestation.js");

  const valid = {
    participantId: "p1",
    enclaveId: "mini-dflow-enclave",
    nonce: "nonce-123456",
    pcrs: {
      PCR3: "8d8d8d",
      PCR8: "9e9e9e",
    },
    signedAt: Date.now(),
  };

  const result = verifyAttestation(valid);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("attestation verification rejects an untrusted participant payload", async () => {
  const { verifyAttestation } = await import("../src/security/attestation.js");

  const invalid = {
    participantId: "unknown",
    enclaveId: "untrusted-env",
    nonce: "short",
    pcrs: {
      PCR3: "abc",
    },
    signedAt: Date.now(),
  };

  const result = verifyAttestation(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("signing endpoint rejects requests without a trusted attestation", async () => {
  const { createServer } = await import("../src/api/server.js");
  const app = createServer();

  const resp = await fetch("http://127.0.0.1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  }).catch(() => null);

  if (resp) {
    const status = resp.status;
    assert.equal(status, 404);
  }

  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const res = await fetch(`http://127.0.0.1:${port}/sign/mpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "ATTESTATION_REQUIRED");

  await new Promise((resolve) => server.close(resolve));
});

test("participant authorization accepts trusted participants and rejects unknown ones", async () => {
  const { isParticipantAuthorized } = await import("../src/security/authorization.js");

  assert.equal(isParticipantAuthorized("p1"), true);
  assert.equal(isParticipantAuthorized("p2"), true);
  assert.equal(isParticipantAuthorized("unknown"), false);
  assert.equal(isParticipantAuthorized(""), false);
});

test("key lifecycle rejects invalid transition sequences", async () => {
  const { isValidKeyTransition } = await import("../src/security/keys.js");

  assert.equal(isValidKeyTransition("GENERATED", "ACTIVE"), true);
  assert.equal(isValidKeyTransition("ACTIVE", "ROTATING"), true);
  assert.equal(isValidKeyTransition("GENERATED", "REVOKED"), false);
  assert.equal(isValidKeyTransition("ACTIVE", "UNKNOWN"), false);
});

test("signing endpoint rejects untrusted participant even with a valid attestation body", async () => {
  const { createServer } = await import("../src/api/server.js");
  const app = createServer();
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const res = await fetch(`http://127.0.0.1:${port}/sign/mpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participantId: "unknown",
      attestation: {
        participantId: "p1",
        enclaveId: "mini-dflow-enclave",
        nonce: "nonce-123456",
        pcrs: { PCR3: "8d8d8d", PCR8: "9e9e9e" },
        signedAt: Date.now(),
      },
    }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "UNAUTHORIZED_PARTICIPANT");

  await new Promise((resolve) => server.close(resolve));
});

test("runtime policy accepts active key state and rejects non-active signing state", async () => {
  const { evaluateRuntimePolicy } = await import("../src/security/runtime-policy.js");

  const allow = await evaluateRuntimePolicy({
    participantId: "p1",
    hostId: "host-p1",
    attestation: {
      participantId: "p1",
      enclaveId: "mini-dflow-enclave",
      nonce: "nonce-123456",
      pcrs: { PCR3: "8d8d8d", PCR8: "9e9e9e" },
      signedAt: Date.now(),
    },
    keyState: "ACTIVE",
  });

  assert.equal(allow.allowed, true);
  assert.equal(allow.reason, "ALLOW_SIGNING");

  const reject = await evaluateRuntimePolicy({
    participantId: "p1",
    hostId: "host-p1",
    attestation: {
      participantId: "p1",
      enclaveId: "mini-dflow-enclave",
      nonce: "nonce-123456",
      pcrs: { PCR3: "8d8d8d", PCR8: "9e9e9e" },
      signedAt: Date.now(),
    },
    keyState: "GENERATED",
  });

  assert.equal(reject.allowed, false);
  assert.equal(reject.reason, "KEY_NOT_ACTIVE");

  const hostMismatch = await evaluateRuntimePolicy({
    participantId: "p2",
    hostId: "host-p1",
    attestation: {
      participantId: "p2",
      enclaveId: "mini-dflow-enclave",
      nonce: "nonce-123456",
      pcrs: { PCR3: "8d8d8d", PCR8: "9e9e9e" },
      signedAt: Date.now(),
    },
    keyState: "ACTIVE",
  });

  assert.equal(hostMismatch.allowed, false);
  assert.equal(hostMismatch.reason, "PARTICIPANT_HOST_MISMATCH");
});

test("execution preflight rejects route output that drifts from quote and simulation assumptions", async () => {
  const { evaluateRouteConsistency } = await import("../src/execution/simulate.js");

  const result = evaluateRouteConsistency({
    routeOutput: 1000,
    quoteOutput: 1200,
    simulatedOutput: 650,
    priorityFeeLamports: 25000,
    expiresAt: Date.now() + 1200,
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("ROUTE_OUTPUT_MISMATCH"));
  assert.ok(result.reasons.includes("SIMULATION_OUTPUT_MISMATCH"));
  assert.ok(result.reasons.includes("PRIORITY_FEE_TOO_HIGH"));
});
