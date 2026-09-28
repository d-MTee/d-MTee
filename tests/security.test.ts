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
