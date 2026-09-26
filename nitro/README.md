# Real AWS Nitro Enclave signer

This is the real TEE boundary, not a local hash-based imitation.

## What is implemented

- Nitro enclave application in Rust
- VSock server on port 5000
- Ed25519 private key generated inside the enclave and never exposed to the parent process
- `attest` operation that obtains a signed Nitro attestation document from the Nitro Secure Module
- `sign` operation that signs only inside enclave memory
- enclave image build script (`nitro-cli build-enclave`)
- PCR0-bound KMS policy template
- run script for a real Nitro-enabled EC2 host

AWS documents that enclave attestation documents contain PCR measurements and can be used by KMS policies; the enclave has no ordinary network access and uses VSock to communicate with its parent. KMS access is normally provided through the AWS `vsock-proxy` / KMS tooling path.

## Important production point

This source proves the TEE implementation, but a Windows/Docker Desktop machine cannot execute a real Nitro enclave. The actual security property exists only after the EIF is launched on a Nitro-enabled EC2 instance. Do not use `--debug-mode` for a production attestation flow; AWS documents that debug-mode PCRs are zeros and cannot be used for cryptographic attestation.

The next production step is KMS-wrapped key persistence: encrypt the enclave signing key/data key with KMS, then release/decrypt it only when the attestation PCR policy matches. AWS provides `kmstool-enclave-cli` specifically for this pattern.
