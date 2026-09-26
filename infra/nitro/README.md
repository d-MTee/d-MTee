# Nitro deployment model

This directory contains the runtime boundary for the signer and the AWS deployment contract.

## Trust boundary

```text
Internet / Agent / API
        |
        v
   Parent EC2
        |
        | VSock only
        v
+-------------------------+
| Nitro Enclave           |
|                         |
| FROST signer / policy   |
| Ed25519 private share   |
| NSM attestation         |
+------------+------------+
             |
             | KMS request + attestation
             v
          AWS KMS
```

The parent instance is deliberately treated as untrusted for key material. It may carry the EIF and ciphertext, but it must not receive plaintext key shares.

## KMS binding

The deployment uses two attestation measurements for runtime authorization:

- **PCR3**: binds access to the expected parent IAM role.
- **PCR8**: binds access to an EIF signing certificate.

AWS documents PCR3 + PCR8 as a flexible pattern because the image can change while the signer identity remains controlled.

The initial CDK deployment creates the KMS key and parent role. `deployment/apply-attestation-policy.sh` is the second phase: it takes the measured PCR3/PCR8 values and installs the final KMS key policy plus the parent role's least-privilege KMS policy.

Do not put plaintext secrets in the EIF. AWS explicitly documents that EIF contents are unencrypted and recommends KMS-backed decryption inside the enclave.

## Local vs AWS

Docker Compose is only the functional development environment. Nitro isolation and hardware attestation require a Nitro-enabled EC2 parent. AWS documents `m5.xlarge` as a supported example and requires Nitro Enclaves to be enabled on the instance.

The parent bootstrap installs the Nitro CLI on Amazon Linux 2023 and preallocates enclave CPUs/memory.
