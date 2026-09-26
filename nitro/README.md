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

## Fail-closed rules

The deployment must stop if any of the following is true:

- the EIF artifact is missing or unsigned
- PCR values are absent or unexpected
- KMS policies contain placeholder values
- the parent role does not match the intended deployment
- the enclave is launched in debug mode for a production path

## Production notes

The enclave should never expose private key material to the parent process. KMS-wrapped key release should happen only after attestation verifies the expected PCR state. AWS tooling such as `vsock-proxy` and KMS enclave integration should be treated as required operational controls, not optional convenience features.
