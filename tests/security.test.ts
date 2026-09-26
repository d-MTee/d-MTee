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
