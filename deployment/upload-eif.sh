#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${STACK_PREFIX:=MiniDflow}"
: "${AWS_REGION:=${CDK_DEFAULT_REGION:-ap-northeast-2}}"
BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Artifacts" --query 'Stacks[0].Outputs[?OutputKey==`ArtifactBucketName`].OutputValue' --output text)"
aws s3 cp "$ROOT/artifacts/mini-dflow-signer.eif" "s3://${BUCKET}/eif/mini-dflow-signer.eif" --region "$AWS_REGION"
aws s3 cp "$ROOT/artifacts/attestation.json" "s3://${BUCKET}/eif/attestation.json" --region "$AWS_REGION"
echo "Uploaded EIF and measurements to s3://${BUCKET}/eif/"
