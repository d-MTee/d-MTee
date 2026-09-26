#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${STACK_PREFIX:=MiniDflow}"
: "${AWS_REGION:=${CDK_DEFAULT_REGION:-ap-northeast-2}}"
INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Nitro" --query 'Stacks[0].Outputs[?OutputKey==`ParentInstanceId`].OutputValue' --output text)"
BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Artifacts" --query 'Stacks[0].Outputs[?OutputKey==`ArtifactBucketName`].OutputValue' --output text)"

COMMANDS=$(cat <<EOF2
[
  "set -e",
  "aws s3 cp s3://${BUCKET}/eif/mini-dflow-signer.eif /opt/mini-dflow/enclave/mini-dflow-signer.eif --region ${AWS_REGION}",
  "nitro-cli terminate-enclave --all || true",
  "nitro-cli run-enclave --eif-path /opt/mini-dflow/enclave/mini-dflow-signer.eif --cpu-count 2 --memory 4096 --enclave-name mini-dflow-signer",
  "nitro-cli describe-enclaves"
]
EOF2
)
CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --parameters commands="$COMMANDS" --region "$AWS_REGION" --query Command.CommandId --output text)
echo "SSM command: $CMD_ID"
echo "Wait with: aws ssm get-command-invocation --command-id $CMD_ID --instance-id $INSTANCE_ID --region $AWS_REGION"
