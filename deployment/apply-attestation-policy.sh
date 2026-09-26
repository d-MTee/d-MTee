#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${AWS_REGION:=${CDK_DEFAULT_REGION:-ap-northeast-2}}"
: "${STACK_PREFIX:=MiniDflow}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
KEY_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Kms" --query 'Stacks[0].Outputs[?OutputKey==`KeyArn`].OutputValue' --output text)"
ROLE_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}Nitro" --query 'Stacks[0].Outputs[?OutputKey==`ParentRoleArn`].OutputValue' --output text)"
ROLE_NAME="${ROLE_ARN##*/}"

MEASUREMENTS="${1:-$ROOT/artifacts/measurements.json}"
if [[ ! -f "$MEASUREMENTS" ]]; then
  echo "Usage: $0 [measurements.json]" >&2
  exit 1
fi

PCR0="$(jq -r '.Measurements.PCR0 // .Measurements.PCR0' "$MEASUREMENTS")"
PCR1="$(jq -r '.Measurements.PCR1 // .Measurements.PCR1' "$MEASUREMENTS")"
PCR2="$(jq -r '.Measurements.PCR2 // .Measurements.PCR2' "$MEASUREMENTS")"
PCR8="$(jq -r '.Measurements.PCR8 // .Measurements.PCR8' "$MEASUREMENTS")"
if [[ -z "$PCR8" || "$PCR8" == "null" ]]; then
  echo "PCR8 missing. Build a signed EIF; debug mode cannot establish the production attestation contract." >&2
  exit 1
fi

# PCR3 is SHA384(role ARN), per Nitro attestation documentation.
PCR3="$(printf '%s' "$ROLE_ARN" | sha384sum | awk '{print $1}')"
export ACCOUNT_ID PARENT_ROLE_ARN="$ROLE_ARN" PCR3 PCR8

python3 - "$ROOT/infra/nitro/kms-policy.template.json" "$ROOT/artifacts/kms-policy.json" <<'PY2'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
for k in ["ACCOUNT_ID", "PARENT_ROLE_ARN", "PCR3", "PCR8"]:
    text = text.replace("${" + k + "}", os.environ[k])
json.dump(json.loads(text), open(dst, "w"), indent=2)
PY2
aws kms put-key-policy \
  --key-id "$KEY_ARN" \
  --policy-name default \
  --policy file://"$ROOT/artifacts/kms-policy.json" \
  --region "$AWS_REGION"

cat > "$ROOT/artifacts/enclave-kms-inline-policy.json" <<EOF2
{
  "Version":"2012-10-17",
  "Statement":[{
    "Effect":"Allow",
    "Action":["kms:Decrypt","kms:GenerateDataKey","kms:GenerateRandom"],
    "Resource":"$KEY_ARN",
    "Condition":{"StringEqualsIgnoreCase":{
      "kms:RecipientAttestation:PCR3":"$PCR3",
      "kms:RecipientAttestation:PCR8":"$PCR8"
    }}
  }]
}
EOF2
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name MiniDflowAttestedKms --policy-document file://"$ROOT/artifacts/enclave-kms-inline-policy.json"

jq -n --arg pcr0 "$PCR0" --arg pcr1 "$PCR1" --arg pcr2 "$PCR2" --arg pcr3 "$PCR3" --arg pcr8 "$PCR8" \
  '{PCR0:$pcr0,PCR1:$pcr1,PCR2:$pcr2,PCR3:$pcr3,PCR8:$pcr8}' > "$ROOT/artifacts/attestation.json"
cat "$ROOT/artifacts/attestation.json"
