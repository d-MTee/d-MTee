#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${STACK_PREFIX:=MiniDflow}"
: "${AWS_REGION:=${CDK_DEFAULT_REGION:-ap-northeast-2}}"

EIF_PATH="$ROOT/artifacts/mini-dflow-signer.eif"
ATTESTATION_PATH="$ROOT/artifacts/attestation.json"

if [[ ! -f "$EIF_PATH" ]]; then
  echo "Missing EIF artifact: $EIF_PATH" >&2
  exit 1
fi

if [[ ! -f "$ATTESTATION_PATH" ]]; then
  echo "Missing attestation artifact: $ATTESTATION_PATH" >&2
  exit 1
fi

aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "AWS credentials are not configured for this shell." >&2
  exit 1
}

BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Artifacts" --query 'Stacks[0].Outputs[?OutputKey==`ArtifactBucketName`].OutputValue' --output text)"

if [[ -z "$BUCKET" || "$BUCKET" == "None" ]]; then
  echo "Could not resolve the artifact bucket for stack ${STACK_PREFIX}Artifacts" >&2
  exit 1
fi

aws s3 cp "$EIF_PATH" "s3://${BUCKET}/eif/mini-dflow-signer.eif" --region "$AWS_REGION" --only-show-errors
aws s3 cp "$ATTESTATION_PATH" "s3://${BUCKET}/eif/attestation.json" --region "$AWS_REGION" --only-show-errors

echo "Uploaded EIF and attestation to s3://${BUCKET}/eif/"
