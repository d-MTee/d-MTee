# d-MTee

A production-shaped reference implementation of a Solana smart-router and
secure transaction-signing infrastructure.

This project combines:

- Smart routing with single-route and split-route optimization
- Redis-backed market data and quote-provider abstraction
- Slippage, price-impact and priority-fee controls
- Solana simulation and preflight
- Approval and policy enforcement
- Tamper-evident audit logging
- Real 2-of-3 FROST Ed25519 threshold signing
- AWS Nitro Enclave signer boundary
- AWS KMS attestation using PCR3 + PCR8
- AWS CDK infrastructure and SSM-based deployment
- VSock-only application boundary

The project demonstrates routing, policy checks, a local FROST cryptographic
demo, and an attested Nitro signing boundary. The end-to-end live transaction
submit/retry path and independently hosted FROST participant protocol are not
implemented; those endpoints fail closed rather than simulate successful signing.

This is a reference implementation, not a production security certification.
The cryptographic primitives are real, while production deployment would
still require independent security review, key ceremony, operational
controls, monitoring, incident response and penetration testing.

## 1. Architecture

```text
                         +----------------------+
                         | Agent / MCP / Client  |
                         +----------+-----------+
                                    |
                                    v
                         +----------------------+
                         | Trading API           |
                         | Intent + Idempotency  |
                         +----------+-----------+
                                    |
                       +------------+-------------+
                       |                          |
                       v                          v
                +-------------+            +-------------+
                | Risk /      |            | Quote / JIT  |
                | Policy      |            | Router       |
                +------+------+            +------+------+ 
                       |                          |
                       +------------+-------------+
                                    v
                         +----------------------+
                         | Solana Simulation    |
                         | Blockhash / Fee /    |
                         | Preflight            |
                         +----------+-----------+
                                    |
                                    v
                         +----------------------+
                         | MPC Coordinator      |
                         | 2-of-3 FROST         |
                         +----+-----------+-----+
                              |           |
                    VSock     |           | VSock
                              v           v
                       +----------+   +----------+
                       | Nitro P1 |   | Nitro P2 |   ... P3
                       | share 1  |   | share 2  |
                       +----+-----+   +----+-----+
                            |              |
                            +------+-------+
                                   |
                                   v
                              FROST aggregate
                                   |
                                   v
                           Solana RPC / send

      AWS control plane
      -----------------
      CDK -> VPC -> EC2 Nitro Parent -> S3 EIF
                         |
                         +-> KMS <--- signed attestation
                                   PCR3 + PCR8

      Parent EC2 is treated as untrusted for plaintext key shares.
```

## 2. What is actually implemented

### Trading path

- `src/quotes/provider.ts`: provider abstraction.
- `src/quotes/simProvider.ts`: deterministic simulated venues.
- `src/quotes/jupiter.ts`: Jupiter quote adapter.
- `src/router/graph.ts`: route and split-route selection.
- `src/execution/simulate.ts`: Solana transaction simulation / fee helpers.
- `src/risk/policy.ts`: amount, slippage and execution policy checks.
- `src/security/approval.ts`: approval token / request binding.
- `src/audit/audit.ts`: hash-chain audit records.
- `src/observability/metrics.ts`: Prometheus metrics.

### MPC

`mpc/frost-signer demo` executes a real 2-of-3 FROST DKG and signing flow using the `frost-ed25519` implementation. All three participants run in one process.

The local demo intentionally co-locates all three participants so it can be reproduced on one machine. That proves the cryptographic protocol path, but it does not provide independent trust domains. Participant HTTP/gRPC mode and `/sign/mpc` are disabled until their DKG/signing handlers use real FROST packages.

Production topology is three independent participants:

```text
Coordinator
   |
   +---- P1 / account A / Nitro enclave
   +---- P2 / account B / Nitro enclave
   `---- P3 / account C / Nitro enclave
```

A coordinator never receives a participant's private share.

### Nitro

`nitro/enclave` is a real Nitro enclave application using the Nitro Secure Module for attestation and VSock for its application boundary.

The AWS deployment adds:

- Nitro-enabled EC2 parent
- private subnet
- SSM instead of SSH management
- S3 artifact bucket
- KMS customer-managed key
- IAM parent role
- Nitro CLI bootstrap
- enclave CPU/memory allocation
- EIF signing and measurement scripts
- PCR3/PCR8 KMS policy application

AWS KMS supports attestation conditions based on the enclave image measurement and PCR values. PCR3 identifies the parent IAM role and PCR8 identifies the EIF signing certificate. AWS recommends PCR3 + PCR8 together when this flexibility is desired.

References:

- AWS Nitro cryptographic attestation: https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html
- AWS KMS attestation: https://docs.aws.amazon.com/enclaves/latest/user/kms.html
- AWS Nitro + KMS getting started: https://docs.aws.amazon.com/enclaves/latest/user/connect-enclave-kms.html
- Nitro CLI installation: https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-cli-install.html
- Nitro CLI build-enclave: https://docs.aws.amazon.com/enclaves/latest/user/cmd-nitro-build-enclave.html

## 3. Repository layout

```text
mini-dflow-v5/
├── src/                       # trading/router/API application
├── tests/                     # application tests
├── mpc/
│   └── frost-signer/          # real 2-of-3 FROST DKG/signing demo
├── nitro/
│   ├── enclave/               # Rust Nitro signer
│   ├── parent/                # parent-side VSock helpers
│   └── kms-policy.json        # example policy
├── infra/
│   ├── cdk/                   # AWS CDK v2 application
│   │   ├── bin/
│   │   └── lib/
│   └── nitro/                 # attestation policy templates + proxy config
├── deployment/
│   ├── create-eif-cert.sh
│   ├── build-eif.sh
│   ├── apply-attestation-policy.sh
│   ├── upload-eif.sh
│   └── deploy-enclave.sh
├── docs/
│   ├── API.md
│   ├── ROUTING.md
│   └── SECURITY.md
└── docker-compose.yml
```

## 4. Local development

Requirements:

- Node.js 20+
- npm
- Docker
- Rust + Cargo for the FROST demo
- Redis

```bash
npm install
npm run redis:up
npm run check:redis
npm run check:participant-policy
cp .env.example .env
docker compose up -d redis
npm run check:redis
npm run build
npm test
npm run dev
```

### Phase 2 operational runbook

Before signing requests are accepted in a real deployment, verify the following checklist:

```bash
# 1) Redis is available
npm run check:redis

# 2) Confirm the per-participant trust configuration is populated from approved measurements
PARTICIPANT_ID=p1 npm run check:participant-policy

# 3) Administrative operations require this bearer header
curl -H "Authorization: Bearer $AUDITOR_CREDENTIAL" http://localhost:8080/key/status
```

The checker validates configuration only; it does not prove live Nitro attestation. `/sign/mpc` is disabled because the available participant rounds are placeholders. Nitro signing additionally requires the complete approval-bound request and a fresh Nitro document; caller-supplied attestation JSON is rejected.

### Production participant isolation policy

For a production deployment, each participant must be pinned to measured AWS identities:

- `PCR3` -> the participant parent IAM role (including account identity)
- `PCR4` -> the participant EC2 instance identity
- `PCR8` -> the approved EIF signing certificate

The server compares these measured values against participant-specific allowlists. Client-provided host/account labels are not considered evidence.

The runtime uses role-based bearer credentials (`admin`, `requester`, `approver`, `signer`, `auditor`) configured in `API_AUTH_TOKENS`; request creation is separated from approval transitions, and signer credentials are participant-scoped. See `docs/API.md` for credential generation, rotation, and revocation. Nitro signing accepts only a signed Nitro COSE document with a pinned certificate root, a fresh one-use challenge, request-bound user data, and configured PCR3/PCR4/PCR8 measurements. Configure `NITRO_TRUSTED_ROOT_SHA256`, participant PCR values, `NITRO_SIGNING_KEY_ID`, `NITRO_EXPECTED_PUBLIC_KEY_HEX`, and `POLICY_AUTHORITY_PUBLIC_KEY_HEX` before enabling Nitro signing; missing values deny requests.

Nitro signing seeds are unwrapped by KMS using the attestation document's RSA recipient key. The parent-side VSock broker is in `nitro/parent/kms_key_broker.py`; it requires a KMS-encrypted 32-byte seed in `NITRO_KMS_CIPHERTEXT_BLOB` and the restrictive PCR3/PCR8 KMS policy. Install and run that broker as a managed service on the parent host before launching the EIF.

The enclave independently enforces an Ed25519 `policyAuthorization` token over the exact transaction hash, approval, route, policy, participant, and key epoch. Its public key is pinned in the EIF and API; the token issuer's private key must live in a separate trusted service. Without this token, a direct VSock request from the untrusted parent cannot obtain a signature.

The runtime also respects environment-controlled safety boundaries for route drift, retry policy, and nonce validation:

```bash
MAX_ROUTE_DRIFT_RATIO=0.15
MAX_PRIORITY_FEE_LAMPORTS=10000
RPC_TIMEOUT_MS=5000
ENABLE_ROUTE_CONSISTENCY_GUARD=true
QUOTE_PROVIDER_RETRY_COUNT=2
QUOTE_PROVIDER_RETRY_DELAY_MS=150
QUOTE_PROVIDER_CIRCUIT_BREAKER_THRESHOLD=3
QUOTE_PROVIDER_CIRCUIT_BREAKER_RESET_MS=60000
TX_NONCE_MAX_AGE_MS=300000
```

These values should be tightened for production rollouts and reviewed with the attestation and execution policy before enabling live signing traffic.

### Deployment runbook

1. Copy `.env.example` to `.env` and fill the production values for your host and participant identities.
2. Ensure the Redis endpoint is reachable and the participant identity matches the configured host/account allowlist.
3. Configure at least one healthy quote provider and set the retry threshold to a low, safe value for the environment.
4. Validate the nonce pipeline before live signing: each submitted transaction must carry a strictly increasing nonce and must not be older than the configured TTL.
5. Keep route drift and priority-fee caps below the production thresholds before switching to live market traffic.

Useful endpoints:

```bash
curl http://localhost:8080/health
curl 'http://localhost:8080/quote?amount=10'
curl 'http://localhost:8080/route/split?amount=100'
curl 'http://localhost:8080/route/jit?amount=100'
curl 'http://localhost:8080/policy?amount=100'
curl http://localhost:8080/simulate
curl http://localhost:8080/priority-fees
curl -H "Authorization: Bearer $AUDITOR_CREDENTIAL" http://localhost:8080/metrics
```

Run the real FROST demo:

```bash
cd mpc/frost-signer
cargo run --release -- demo
```

### Distributed participant mode

The previous Windows bootstrap and Java simulator used placeholder DKG packages
and signature shares. They now stop with `DISTRIBUTED_FROST_NOT_IMPLEMENTED` and
do not kill listeners or start mock signer processes. Use the `demo` command above
for the supported single-process FROST cryptographic demonstration.

### Current repository state

The repository now separates two distinct concerns clearly:

- local cryptographic proof: `mpc/frost-signer` validates the 2-of-3 FROST DKG and signing flow in-process;
- distributed participant flow: placeholder participant rounds are explicitly disabled until real FROST rounds and authenticated transport are implemented;
- AWS deployment flow: Nitro + KMS + attestation remains a separate deployment path and requires its measured PCR policy and KMS broker configuration.

This keeps the proof-of-logic and production deployment guidance separate while still preserving the real-enclave architecture story.

## 5. AWS deployment

Before uploading the enclave image, confirm that the artifacts were built successfully and the AWS identity is configured:

```bash
ls -l artifacts/mini-dflow-signer.eif artifacts/attestation.json
aws sts get-caller-identity
./deployment/upload-eif.sh
```

The upload script validates the required artifacts and the active AWS session before pushing files to S3.

### Step A — install CDK dependencies

```bash
cd infra/cdk
npm install
npx cdk bootstrap
```

The default region is `ap-northeast-2`. Override it with:

```bash
export CDK_DEFAULT_REGION=ap-northeast-2
```

### Step B — deploy the infrastructure

```bash
npx cdk synth
npx cdk deploy --all
```

The stacks create:

```text
MiniDflowNetwork
MiniDflowArtifacts
MiniDflowKms
MiniDflowNitro
```

The Nitro stack uses an `m5.xlarge` by default. The instance is created with Nitro Enclaves enabled, private networking and SSM management.

Change the size with CDK context:

```bash
npx cdk deploy --all \
  -c instanceType=m5.2xlarge \
  -c enclaveCpuCount=2 \
  -c enclaveMemoryMiB=4096 \\
  -c participantId=p1
```

### Step C — create EIF signing material

```bash
cd ../..
./deployment/create-eif-cert.sh
```

The signing private key is intentionally ignored by Git. In a real CI/CD system, store it in a dedicated protected signing system rather than the parent EC2 filesystem.

### Step D — build the signed EIF

First provision an encrypted signing-seed bundle using
`deployment/provision-signing-seed.py`; export `NITRO_SIGNING_KEY_ID` from its
`keyId`, and set `NITRO_PARTICIPANT_ID` and
`NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX`. Then build on a Linux machine with
Docker and Nitro CLI available, normally a dedicated build host:

```bash
./deployment/build-eif.sh
```

The command produces:

```text
artifacts/
├── mini-dflow-signer.eif
├── measurements.json
└── eif-description.json
```

A signed EIF is important because PCR8 represents the EIF signing certificate.
The API's `NITRO_EXPECTED_PUBLIC_KEY_HEX` must match the public-key pin in the
same seed bundle. After approving measurements and applying the KMS policy,
install the participant ciphertext and parent broker with
`PARTICIPANT_ID=p1 bash deployment/install-kms-broker.sh <seed-bundle.json>`.
Verify the running enclave and its KMS-unwrapped key pin with
`PARTICIPANT_ID=p1 bash deployment/verify-live-enclave.sh <seed-bundle.json>`.
See [KMS bootstrap and rotation](docs/security/KMS_BOOTSTRAP_ROTATION.md) for
the complete order, rollback, and recovery details.

### Step E — bind KMS to the enclave measurement

```bash
./deployment/apply-attestation-policy.sh
```

This calculates PCR3 from the parent IAM role ARN, reads PCR8 from the signed EIF measurements and installs:

1. the KMS key resource policy;
2. the parent role's least-privilege KMS policy.

Before this step, the enclave has no usable KMS runtime permission.

### Step F — upload and launch

```bash
./deployment/upload-eif.sh
./deployment/deploy-enclave.sh
```

The parent downloads the EIF from the private S3 bucket and launches it with Nitro CLI.

Inspect the enclave:

```bash
aws ssm send-command \
  --instance-ids <PARENT_INSTANCE_ID> \
  --document-name AWS-RunShellScript \
  --parameters commands='["nitro-cli describe-enclaves"]'
```

## 6. KMS / key-share lifecycle

The important security rule is:

```text
Encrypted share outside enclave
          |
          v
       AWS KMS
          |
   signed attestation
     PCR3 + PCR8
          |
          v
   plaintext share only
   inside Nitro memory
```

Never place the plaintext share in:

- Docker build arguments
- the Docker image
- the EIF filesystem
- Git
- `.env`
- S3 plaintext
- CloudWatch logs
- parent process memory

The KMS key is used as the authorization boundary. AWS KMS receives the enclave's signed attestation document with the cryptographic request and checks the configured PCR conditions.

For a full 2-of-3 deployment, use separate participant environments. Do not put all three shares on one EC2 parent and call that independent MPC.

## 7. Production MPC topology

Recommended:

```text
AWS account A                 AWS account B                 AWS account C
------------                  ------------                  ------------
Nitro P1                      Nitro P2                      Nitro P3
FROST share #1                FROST share #2                FROST share #3
KMS key A                     KMS key B                     KMS key C
IAM role A                    IAM role B                    IAM role C
```

The coordinator asks two participants to sign a canonical transaction hash. Each participant independently verifies:

- request ID
- nonce
- expiry
- chain ID
- transaction hash
- route/risk policy digest
- approval token
- signer key epoch
- allowed program IDs
- maximum notional
- slippage limit

Only then does the enclave produce its FROST signature share.

## 8. Why CDK is used here

CDK is the infrastructure control plane, not the Nitro runtime.

```text
CDK
 |
 +-- VPC
 +-- private subnets
 +-- EC2 Nitro parent
 +-- IAM
 +-- KMS
 +-- S3
 +-- security groups
 +-- SSM

Nitro CLI / EIF pipeline
 |
 +-- Docker image
 +-- EIF
 +-- PCR0/1/2
 +-- EIF signature
 +-- PCR8
 +-- nitro-cli run-enclave
```

That separation matters. CDK can create the AWS resources, but the actual enclave image is built and measured by Nitro tooling.

## 9. Security model

### What the design protects against

- normal application code reading a Nitro enclave's private memory
- parent EC2 directly reading plaintext enclave memory
- an unsigned or differently signed EIF satisfying the PCR8 condition
- a different parent IAM role satisfying the PCR3 condition
- accidental secret inclusion in the EIF when the KMS wrapping pattern is followed
- replay of stale trading requests when the application-level nonce/expiry policy is enforced

### What it does not magically solve

- compromised coordinator logic
- malicious trading policy configuration
- bad transaction construction
- compromised CI/CD signing key
- stolen AWS account root/admin credentials
- denial of service
- incorrect FROST participant membership
- operational mistakes during key ceremony
- application vulnerabilities outside the enclave
- supply-chain vulnerabilities in dependencies

Those require operational controls and independent review.

## 10. Development vs production

| Area | Local | Production target |
|---|---|---|
| Market data | Redis simulator / WS | exchange WS + reconciliation |
| Router | local process | horizontally scaled service |
| Signing | FROST demo | 3 isolated Nitro participants |
| TEE | Docker-like signer boundary | hardware Nitro Enclave |
| Secrets | local env for non-secret config | KMS + attestation |
| State | Redis | Redis + durable order/event store |
| Deployment | Docker Compose | CDK + CI/CD + SSM |
| Audit | Redis/hash chain | durable append-only storage + CloudTrail |
| Approval | local policy | policy service + independent approvals |
| Solana send | dry-run/default | controlled signer + RPC failover |

## 11. Test checklist

Before enabling real execution:

```text
[ ] npm test
[ ] cargo test / cargo run --release -- demo
[ ] CDK synth
[ ] deploy into a dedicated AWS account
[ ] build a signed EIF
[ ] verify PCR0/1/2
[ ] verify PCR8 is non-zero
[ ] calculate PCR3 from the expected IAM role ARN
[ ] apply KMS policy
[ ] prove wrong PCR8 -> KMS AccessDenied
[ ] prove wrong IAM role -> KMS AccessDenied
[ ] prove correct enclave -> KMS decrypt succeeds
[ ] prove parent cannot obtain plaintext share
[ ] prove replayed signing request is rejected
[ ] prove changed transaction hash changes the signed message
[ ] prove participant loss still permits 2-of-3 operation
[ ] prove one participant alone cannot sign
[ ] run failure/recovery and key-rotation drills
```

## 12. Important note

The previous v4 project stopped at the cryptographic implementation boundary. v5 adds the AWS infrastructure and attestation deployment path so the project can move from:

```text
"the signer code exists"
```

to:

```text
"the signer runs in a measured Nitro enclave and KMS only releases
protected material to the expected enclave identity"
```

The remaining step for a true exchange-grade deployment is not another placeholder signer. It is operational hardening: independent participant accounts, protected EIF signing, durable encrypted share storage, key ceremony, monitoring, recovery, formal threat modeling and an external security audit.


## Production Readiness

This repository is a deployable reference implementation rather than a
security-certified production system.

The cryptographic primitives and AWS Nitro/KMS attestation path are implemented
as real components. A production exchange deployment would additionally
require independent security review, protected key ceremony, multi-account
participant isolation, hardened CI/CD signing, monitoring, incident response,
recovery procedures and penetration testing.

The main goal of this project is to demonstrate the engineering boundary
between a trading system, threshold signing, hardware-backed isolation and
cloud attestation.
