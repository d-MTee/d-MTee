# Nitro KMS bootstrap and signing-key rotation

This procedure stores only KMS ciphertext on the parent. The EIF receives the
key epoch and policy public key at build time; the API receives the epoch and
expected public-key pin from the seed bundle. The parent broker is installed
as a systemd service and reads the ciphertext from a participant-scoped SSM
SecureString.

## Bootstrap

1. Create/deploy the KMS and Nitro stacks with the same CDK participant context
   used by the EIF and seed bundle (for example `cdk deploy --all --context participantId=p1`). The parent IAM role can read only that participant's
   SSM ciphertext parameter. Restrict operator permissions to
   `kms:GenerateRandom`, `kms:Encrypt`, and the deployment actions needed for
   the KMS policy, SSM parameter, S3 artifact, and SSM command.
2. On a trusted operator workstation with Python `boto3` and `cryptography`,
   generate a seed bundle. The seed is returned by KMS GenerateRandom, encrypted
   immediately, never written to disk, and held in process memory only while the
   public key is derived. Memory wiping is best-effort because Python/SDK copies
   may persist until process exit:

   ```bash
   python -m pip install boto3 cryptography
   umask 077
   python deployment/provision-signing-seed.py \
     --key-id alias/mini-dflow-enclave-share \
     --region ap-northeast-2 \
     --output artifacts/p1-seed-bundle.json
   ```

   Protect the output file. It contains ciphertext, key epoch, KMS key ID, and
   public-key pin, but no plaintext seed.
3. Build a participant-specific signed EIF using the bundle's `keyId`, approved
   PCR measurements, the external policy authority public key, and the
   participant ID. The build script now passes those required values as Docker
   build arguments:

   ```bash
   export NITRO_PARTICIPANT_ID=p1
   export NITRO_SIGNING_KEY_ID='<keyId from bundle>'
   export NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX='<approved raw Ed25519 public key>'
   deployment/build-eif.sh
   ```

   Keep the EIF signing private key outside the source tree and use a controlled
   signing ceremony. Review `artifacts/measurements.json` independently before
   applying the KMS policy. Then run `deployment/verify-deployment.sh`,
   `deployment/apply-attestation-policy.sh`, and `deployment/upload-eif.sh`.
4. Install or update the parent broker for that participant:

   ```bash
   PARTICIPANT_ID=p1 bash deployment/install-kms-broker.sh artifacts/p1-seed-bundle.json
   ```

   The script stores the KMS ciphertext in
   `/mini-dflow/p1/kms-ciphertext` as an SSM SecureString, uploads the broker
   and systemd unit, and asks the Nitro parent to install/restart the service.
   The EC2 role is scoped to read only this parameter path. Confirm the SSM
   command completed and the service is active before launching the enclave.
5. Set the API's `NITRO_SIGNING_KEY_ID` and
   `NITRO_EXPECTED_PUBLIC_KEY_HEX` from the same bundle, update its participant
   PCR3/PCR4 and shared PCR8 allowlists from approved measurements, and roll out
   the API. Launch the EIF, then verify the live broker, enclave and key pin:

   ```bash
   PARTICIPANT_ID=p1 bash deployment/verify-live-enclave.sh artifacts/p1-seed-bundle.json
   ```

   This checks broker/enclave state and calls `identity` over VSock, which
   confirms the enclave's KMS-unwrapped public key matches the bundle. Test KMS
   denial and a valid attestation before enabling signing.

## Rotation

1. Issue a new bundle to a new output path. Do not overwrite the active bundle.
2. Build and sign a new EIF with the new `keyId` and precompute its PCR values.
3. Approve and deploy the new PCR allowlists and KMS attestation policy, then
   update the SSM ciphertext and restart the broker with
   `install-kms-broker.sh`. `put-parameter --overwrite` creates a new SSM
   parameter version. Preserve the previous ciphertext in the controlled
   recovery escrow until rotation is accepted.
4. Deploy the API's new key epoch and public-key pin, update approvals to bind
   the new epoch, launch the new EIF, and verify its identity and attested KMS
   release. Keep the old enclave available only for a defined rollback window.
5. After the rollback window, remove old PCR values and old epoch approvals,
   terminate the old enclave, delete prior SSM parameter versions when policy
   permits, and record the rotation in the audit trail.

## Recovery and limitations

- The encrypted seed bundle/ciphertext is the recovery artifact. Back it up in
  an access-controlled, versioned store separate from the parent host. Recovery
  requires the KMS key and an enclave whose attestation satisfies the current
  policy; loss of the KMS key makes the seed unrecoverable.
- This repository cannot verify a live Nitro launch, AWS account permissions,
  deployed PCR values, or actual KMS policy behavior from a developer machine.
  The final acceptance must run on the target Nitro host and AWS account.
- KMS key automatic rotation rotates KMS's wrapping key, not the Ed25519
  signing seed. The procedure above creates a new signing epoch explicitly.
- A policy-authority private key and EIF signing key are separate secrets and
  must use independent controls and recovery plans.
