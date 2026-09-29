#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${AWS_REGION:=${CDK_DEFAULT_REGION:-ap-northeast-2}}"
: "${STACK_PREFIX:=MiniDflow}"
: "${PARTICIPANT_ID:?Set participant ID matching the enclave image}"
SEED_BUNDLE="${1:?Usage: $0 seed-bundle.json}"
[[ "$PARTICIPANT_ID" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || { echo "Invalid participant ID" >&2; exit 1; }
[[ "$AWS_REGION" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid AWS region" >&2; exit 1; }
[[ -f "$SEED_BUNDLE" ]] || { echo "Missing seed bundle: $SEED_BUNDLE" >&2; exit 1; }
command -v jq >/dev/null
command -v aws >/dev/null

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Nitro" --query 'Stacks[0].Outputs[?OutputKey==`ParentInstanceId`].OutputValue' --output text --region "$AWS_REGION")"
BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Artifacts" --query 'Stacks[0].Outputs[?OutputKey==`ArtifactBucketName`].OutputValue' --output text --region "$AWS_REGION")"
KEY_ID="$(jq -er '.keyId' "$SEED_BUNDLE")"
CIPHERTEXT="$(jq -er '.ciphertextBlob' "$SEED_BUNDLE")"
[[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != None && -n "$BUCKET" && "$BUCKET" != None ]]
PARAMETER_NAME="/mini-dflow/${PARTICIPANT_ID}/kms-ciphertext"

aws ssm put-parameter --name "$PARAMETER_NAME" --type SecureString --value "$CIPHERTEXT" --overwrite --region "$AWS_REGION" >/dev/null
aws s3 cp "$ROOT/nitro/parent/kms_key_broker.py" "s3://${BUCKET}/security/kms_key_broker.py" --region "$AWS_REGION" --only-show-errors
aws s3 cp "$ROOT/nitro/parent/configure_kms_broker.py" "s3://${BUCKET}/security/configure_kms_broker.py" --region "$AWS_REGION" --only-show-errors
aws s3 cp "$ROOT/nitro/parent/vsock_client.py" "s3://${BUCKET}/security/vsock_client.py" --region "$AWS_REGION" --only-show-errors
aws s3 cp "$ROOT/nitro/parent/mini-dflow-kms-broker.service" "s3://${BUCKET}/security/mini-dflow-kms-broker.service" --region "$AWS_REGION" --only-show-errors

PARAMS="$(jq -n --arg bucket "$BUCKET" --arg region "$AWS_REGION" --arg parameter "$PARAMETER_NAME" '{commands:[
  "set -euo pipefail",
  "dnf install -y python3-boto3",
  "install -d -m 0755 /opt/mini-dflow /etc/mini-dflow",
  ("aws s3 cp s3://" + $bucket + "/security/kms_key_broker.py /opt/mini-dflow/kms_key_broker.py --region " + $region),
  ("aws s3 cp s3://" + $bucket + "/security/configure_kms_broker.py /opt/mini-dflow/configure_kms_broker.py --region " + $region),
  ("aws s3 cp s3://" + $bucket + "/security/vsock_client.py /opt/mini-dflow/vsock_client.py --region " + $region),
  ("aws s3 cp s3://" + $bucket + "/security/mini-dflow-kms-broker.service /etc/systemd/system/mini-dflow-kms-broker.service --region " + $region),
  ("python3 /opt/mini-dflow/configure_kms_broker.py " + $parameter + " " + $region),
  "systemctl daemon-reload",
  "systemctl enable mini-dflow-kms-broker.service",
  "systemctl restart mini-dflow-kms-broker.service",
  "systemctl is-active --quiet mini-dflow-kms-broker.service"
]}' )"
COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --parameters "$PARAMS" --region "$AWS_REGION" --query Command.CommandId --output text)"
echo "Broker install command: $COMMAND_ID"
echo "Participant: $PARTICIPANT_ID; key epoch: $KEY_ID"
echo "Inspect with: aws ssm get-command-invocation --command-id $COMMAND_ID --instance-id $INSTANCE_ID --region $AWS_REGION"
