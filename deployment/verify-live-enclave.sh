#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${AWS_REGION:=${CDK_DEFAULT_REGION:-ap-northeast-2}}"
: "${STACK_PREFIX:=MiniDflow}"
: "${PARTICIPANT_ID:?Set participant ID matching the deployed Nitro stack}"
BUNDLE="${1:?Usage: $0 seed-bundle.json}"
[[ "$PARTICIPANT_ID" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || { echo "Invalid participant ID" >&2; exit 1; }
[[ "$AWS_REGION" =~ ^[a-z0-9-]+$ && -f "$BUNDLE" ]] || { echo "Invalid region or missing seed bundle" >&2; exit 1; }
command -v aws >/dev/null
command -v jq >/dev/null
command -v python3 >/dev/null

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Nitro" --query 'Stacks[0].Outputs[?OutputKey==`ParentInstanceId`].OutputValue' --output text --region "$AWS_REGION")"
EXPECTED_PUBLIC_KEY="$(jq -er '.expectedPublicKeyHex' "$BUNDLE" | tr '[:upper:]' '[:lower:]')"
EXPECTED_KEY_ID="$(jq -er '.keyId' "$BUNDLE")"
[[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != None ]]

ENCLAVE_CHECK="nitro-cli describe-enclaves | jq -e 'any(.[]; .State == \"RUNNING\" and .EnclaveCID == 16)' >/dev/null"
PARAMS="$(jq -n --arg check "$ENCLAVE_CHECK" '{commands:["set -euo pipefail", "systemctl is-active --quiet mini-dflow-kms-broker.service", $check, "python3 /opt/mini-dflow/vsock_client.py identity"]}')"
COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --parameters "$PARAMS" --region "$AWS_REGION" --query Command.CommandId --output text)"

RESULT=""
for _ in $(seq 1 40); do
  if RESULT="$(aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" --region "$AWS_REGION" --output json 2>/dev/null)"; then
    STATUS="$(jq -r '.Status' <<<"$RESULT")"
    case "$STATUS" in
      Success) break ;;
      Failed|Cancelled|TimedOut|Cancelling)
        jq -r '.StandardErrorContent // .StatusDetails' <<<"$RESULT" >&2
        exit 1
        ;;
    esac
  fi
  sleep 3
done
[[ -n "$RESULT" && "$(jq -r '.Status' <<<"$RESULT")" == "Success" ]] || { echo "Live enclave check timed out: $COMMAND_ID" >&2; exit 1; }

IDENTITY="$(jq -er '.StandardOutputContent | fromjson | select(.ok == true) | .public_key' <<<"$RESULT")"
ACTUAL_PUBLIC_KEY="$(python3 -c 'import base64,sys; print(base64.b64decode(sys.argv[1], validate=True).hex())' "$IDENTITY")"
[[ "${ACTUAL_PUBLIC_KEY,,}" == "$EXPECTED_PUBLIC_KEY" ]] || { echo "Enclave public-key pin mismatch" >&2; exit 1; }
echo "Live Nitro checks passed for ${PARTICIPANT_ID}; key epoch ${EXPECTED_KEY_ID}; public-key pin matches the seed bundle."
