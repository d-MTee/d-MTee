# AWS deployment runbook

## Order of operations

```text
1. cdk bootstrap
2. cdk deploy --all
3. create EIF signing certificate
4. build signed EIF
5. inspect PCR0/1/2/8
6. calculate PCR3 from parent role ARN
7. install KMS resource + IAM attestation policy
8. upload EIF to private S3
9. launch enclave through SSM
10. verify attestation and KMS decrypt
```

## Why there are two deployment phases

PCR3 depends on the final IAM role ARN, while PCR8 depends on the EIF signing certificate. Neither is a stable value that should be guessed during the first CDK synthesis.

Therefore CDK creates the infrastructure first, and the measured enclave artifact is bound afterward.

## Failure conditions

The deployment must fail closed if:

- EIF is unsigned
- PCR8 is missing
- measurement JSON is missing
- KMS policy contains placeholder values
- the parent role ARN does not match the expected deployment
- enclave is launched in debug mode for a production signing path

## Deployment preflight

Before the KMS policy is rewritten, validate all required artifacts and infrastructure:

```bash
./deployment/verify-deployment.sh
./deployment/build-eif.sh
./deployment/apply-attestation-policy.sh ./artifacts/measurements.json
./deployment/upload-eif.sh
```

This fails closed if the AWS stacks, PCR measurements, EIF artifact, or target KMS role are not ready.

## Rollout

For a production rollout, add a release gate between `build-eif.sh` and `apply-attestation-policy.sh`.

Recommended gate:

```text
source commit
    |
unit/integration tests
    |
container scan
    |
EIF build
    |
measurement approval
    |
release approval
    |
KMS PCR policy update
    |
parent deployment
    |
attestation smoke test
```
