# Nitro enclave operational guide

This directory contains the real TEE boundary for the signing flow. It is intentionally separate from the local MPC demo and represents the production boundary that enforces code and attestation integrity before key material is released.

## Purpose

- package the enclave as an EIF image
- run the enclave on Nitro-capable infrastructure
- obtain attestation evidence from the Nitro Secure Module
- bind signing access to KMS policy conditions
- keep private key material inside the enclave boundary

## Components

- Rust enclave application under `nitro/enclave/`
- VSock bridge for parent-to-enclave communication
- `build-enclave.sh` for image build and EIF packaging
- `run-enclave.sh` for enclave launch
- attestation and KMS integration under `deployment/` and `infra/`

## Prerequisites

A real Nitro execution environment requires:

- Nitro-enabled EC2 host or comparable Nitro-capable runner
- Docker installed for the enclave container build
- `nitro-cli` installed and usable on the host
- a valid EIF signing artifact or deployment certificate when preparing production attestation

> A Windows workstation with Docker Desktop cannot run a real Nitro enclave in the same way as a Nitro-enabled Linux EC2 instance. The secure property exists only after the EIF is launched in a supported Nitro environment.

## Quick start

Build the enclave:

```bash
./nitro/build-enclave.sh
```

Run the packaged EIF:

```bash
./nitro/run-enclave.sh
```

Override memory and CPU settings if needed:

```bash
NITRO_MEMORY=4096 NITRO_CPU_COUNT=4 ./nitro/run-enclave.sh
```

## Operational flow

1. Build the signing container.
2. Package it into an EIF artifact.
3. Verify the artifact exists and is signed as expected.
4. Measure PCR values and confirm they match the deployment target.
5. Apply the KMS attestation policy only after the measurements are approved.
6. Launch the enclave on the Nitro host.
7. Validate attestation and key release checks before signing.

### KMS-backed persistent signing seed

The enclave no longer creates a fresh signing key at every boot. Before launch,
create a KMS-generated random 32-byte Ed25519 seed and encrypted metadata bundle
with `deployment/provision-signing-seed.py`. The plaintext seed is not written
to disk; Python/SDK memory zeroization is best-effort. Store only the base64
`CiphertextBlob` in the participant-scoped SSM SecureString by running
`PARTICIPANT_ID=p1 bash deployment/install-kms-broker.sh <seed-bundle.json>`. The
script installs the broker under systemd on VSock port 5001
with an instance profile that permits `kms:Decrypt` only under the deployed
PCR3/PCR8 recipient-attestation policy. Install the broker script as
`/opt/mini-dflow/kms_key_broker.py`, install
`nitro/parent/mini-dflow-kms-broker.service` into `/etc/systemd/system/`, and
create `/etc/mini-dflow/kms-broker.env` mode `0600` containing only
`NITRO_KMS_CIPHERTEXT_BLOB=<base64 KMS CiphertextBlob>` and `AWS_REGION=<region>`.
The installer performs these host steps. Keep the seed out of the EIF, shell
history, and parent filesystem. Only the encrypted ciphertext is stored in SSM.
The broker returns only KMS's
`CiphertextForRecipient`; the enclave decrypts it with the ephemeral RSA key
whose public key is inside the signed attestation document, then zeroizes the
plaintext buffer.

Set `NITRO_SIGNING_KEY_ID` to the key epoch and `NITRO_EXPECTED_PUBLIC_KEY_HEX`
to the Ed25519 public key in the generated metadata bundle. The API compares
the key pin and epoch with the enclave response and Redis lifecycle state. The enclave signs the exact approved Solana message
bytes; request metadata and the key epoch are checked by the API before signing.
Rotation is documented in `docs/security/KMS_BOOTSTRAP_ROTATION.md`; it provisions
a new seed epoch, updates the PCR-bound EIF/KMS policy and SSM ciphertext, then
rolls the API key pin and approvals.
Obtain the public-key pin from the enclave's `identity` VSock operation after
successful KMS seed unwrapping, for example with
`nitro/parent/vsock_client.py identity` on the parent host.

The API verifier separately requires the AWS Nitro root certificate SHA-256
fingerprint and participant-specific PCR3 and PCR4 values plus shared PCR8.
PCR3 binds the parent IAM role, PCR4 the parent instance, and PCR8 the EIF signing
certificate. Obtain values from trusted deployment measurements; placeholder or
missing values cause signing denial. This local verifier and KMS recipient policy
must be configured from the same approved measurements.

The enclave also requires `NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX`,
`NITRO_PARTICIPANT_ID`, and `NITRO_SIGNING_KEY_ID` baked into the EIF. It refuses
to sign unless the caller supplies a fresh Ed25519 policy-authorization token
signed by the matching external authority. That private signing key must remain
outside the API parent host; the API only verifies tokens with its pinned public
key and forwards the token to the enclave.

## Fail-closed rules

The deployment must stop if any of the following is true:

- the EIF artifact is missing or unsigned
- PCR values are absent or unexpected
- KMS policies contain placeholder values
- the parent role does not match the intended deployment
- the enclave is launched in debug mode for a production path

## Production notes

The enclave should never expose private key material to the parent process. KMS-wrapped key release should happen only after attestation verifies the expected PCR state. AWS tooling such as `vsock-proxy` and KMS enclave integration should be treated as required operational controls, not optional convenience features.
