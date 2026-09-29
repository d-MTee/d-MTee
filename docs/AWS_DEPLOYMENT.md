# AWS deployment operational guide

This runbook defines the complete deployment path for the MPC + Nitro TEE architecture from infrastructure bootstrap through enclave attestation and key release.

## Deployment objective

Deploy the supporting AWS infrastructure, prepare the measured enclave artifact, bind the KMS attestation policy to the final PCR values, and only then allow enclave-based signing operations to proceed.

> Important: the local `mpc/frost-signer` flow proves the FROST DKG and signing logic on one machine. This runbook is the AWS production deployment path for Nitro enclaves, KMS attestation, and fail-closed key release.

## Deployment phases

### Phase 1: bootstrap the environment

Prepare the AWS account and platform bootstrap state before the enclave is measured:

```bash
cd infra/cdk
npm install
cdk bootstrap
cdk deploy --all
```

This step creates the network, IAM, KMS, and Nitro-related infrastructure needed to support the enclave runtime.

### Phase 2: prepare attestation inputs

Validate the deployment state and artifacts before policy installation:

```bash
./deployment/verify-deployment.sh
```

This should fail closed if the required stacks, artifact outputs, PCR values, or KMS configuration are not ready.

### Phase 3: provision signing key and build the enclave artifact

Follow [KMS bootstrap and rotation](security/KMS_BOOTSTRAP_ROTATION.md) to
create the encrypted signing-seed bundle first. Use its key epoch as
`NITRO_SIGNING_KEY_ID` and select the same participant context used by CDK.

Build the EIF image and capture the measurement metadata:

```bash
./deployment/build-eif.sh
```

If the build process produces a measurement file, review the values before proceeding. PCR8 and related measurements must be inspected and approved.

### Phase 4: bind the attestation policy

Apply the measured policy once the final deployment values are known:

```bash
./deployment/apply-attestation-policy.sh ./artifacts/measurements.json
```

This step must only execute after the final parent role ARN and enclave measurement values are stable. PCR3 depends on the parent role; PCR8 depends on the EIF signing certificate. Neither should be guessed early.

After policy application, install the participant-scoped ciphertext and KMS
broker with `PARTICIPANT_ID=<id> bash deployment/install-kms-broker.sh <seed-bundle>`.

### Phase 5: publish the artifact

Upload the enclave artifact to the secure target storage before launch:

```bash
./deployment/upload-eif.sh
```

The upload step should validate that the artifact, destination, and authenticated metadata all line up with the approved deployment target.

### Phase 6: launch and verify the enclave

Once the artifact is published and the policy is in place, launch the enclave and confirm the attestation path is valid:

```bash
./nitro/run-enclave.sh
```

Follow with the attestation and KMS verification sequence required by the production signing path.

## Required gating checks

The deployment must fail closed if any of these conditions are true:

- EIF is missing, unsigned, or stale
- PCR measurements are absent or untrusted
- `measurements.json` is incomplete
- the KMS policy still contains placeholder values
- the parent role ARN differs from the approved target
- the enclave is launched in debug mode for production use

## Recommended release gate

Use a controlled release gate between building and policy application:

```text
source commit
  -> unit and integration tests
  -> dependency and container checks
  -> EIF build
  -> measurement review
  -> release approval
  -> KMS PCR policy update
  -> enclave launch
  -> attestation smoke test
```

## Operational checklist

- [ ] AWS bootstrap complete
- [ ] CDK stacks deployed successfully
- [ ] EIF artifact built and measured
- [ ] PCR values reviewed and approved
- [ ] KMS policy updated with the final target values
- [ ] enclave artifact uploaded to the secure destination
- [ ] enclave launched on Nitro-enabled infrastructure
- [ ] attestation and decryption checks verified

## Production note

This flow is intentionally fail-closed. The project should never allow a signing action to proceed if attestation evidence is incomplete, unstable, or mismatched to the intended deployment identity.
