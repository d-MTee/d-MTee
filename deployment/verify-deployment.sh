#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${STACK_PREFIX:=MiniDflow}"
: "${AWS_REGION:=${CDK_DEFAULT_REGION:-ap-northeast-2}}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path" >&2
    exit 1
  fi
}

require_cmd aws
require_cmd jq

aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "AWS credentials are not configured for this shell." >&2
  exit 1
}

for stack in "${STACK_PREFIX}Artifacts" "${STACK_PREFIX}Kms" "${STACK_PREFIX}Nitro"; do
  aws cloudformation describe-stacks --stack-name "$stack" --region "$AWS_REGION" >/dev/null 2>&1 || {
    echo "Required stack not found: $stack" >&2
    exit 1
  }
  echo "Validated stack: $stack"
done

ARTIFACT_BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Artifacts" --query 'Stacks[0].Outputs[?OutputKey==`ArtifactBucketName`].OutputValue' --output text --region "$AWS_REGION")"
KEY_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Kms" --query 'Stacks[0].Outputs[?OutputKey==`KeyArn`].OutputValue' --output text --region "$AWS_REGION")"
ROLE_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Nitro" --query 'Stacks[0].Outputs[?OutputKey==`ParentRoleArn`].OutputValue' --output text --region "$AWS_REGION")"

[[ -n "$ARTIFACT_BUCKET" && "$ARTIFACT_BUCKET" != "None" ]] || {
  echo "Artifact bucket output is missing." >&2
  exit 1
}

[[ -n "$KEY_ARN" && "$KEY_ARN" != "None" ]] || {
  echo "Key ARN output is missing." >&2
  exit 1
}

[[ -n "$ROLE_ARN" && "$ROLE_ARN" != "None" ]] || {
  echo "Parent role ARN output is missing." >&2
  exit 1
}

require_file "$ROOT/artifacts/measurements.json"

if ! jq -e '.Measurements.PCR8' "$ROOT/artifacts/measurements.json" >/dev/null 2>&1; then
  echo "Artifact measurements are incomplete; PCR8 is required before attestation policy installation." >&2
  exit 1
fi

if [[ ! -f "$ROOT/artifacts/mini-dflow-signer.eif" ]]; then
  echo "EIF artifact is missing. Build it before deployment." >&2
  exit 1
fi

echo "Deployment preflight passed for ${STACK_PREFIX}"
echo "Artifact bucket: ${ARTIFACT_BUCKET}"
echo "KMS key ARN: ${KEY_ARN}"
echo "Parent role ARN: ${ROLE_ARN}"
