#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts"
mkdir -p "$OUT"

: "${EIF_NAME:=mini-dflow-signer}"
: "${EIF_VERSION:=5.0.0}"
: "${EIF_SIGNING_KEY:=deployment/keys/eif-signing.key}"
: "${EIF_SIGNING_CERT:=deployment/keys/eif-signing.crt}"
: "${NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX:?Set the external policy authority public key}"
: "${NITRO_PARTICIPANT_ID:?Set the participant identity for this EIF}"
: "${NITRO_SIGNING_KEY_ID:?Set the KMS-wrapped signing key epoch}"
: "${DOCKER_IMAGE:=${EIF_NAME}:${EIF_VERSION}}"

if ! command -v nitro-cli >/dev/null 2>&1; then
  echo "nitro-cli is required. Run this on a Nitro-enabled parent or another host with Nitro CLI." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build the enclave image." >&2
  exit 1
fi

if [[ ! -f "$EIF_SIGNING_KEY" || ! -f "$EIF_SIGNING_CERT" ]]; then
  echo "Missing EIF signing key/certificate. Run deployment/create-eif-cert.sh first." >&2
  exit 1
fi

docker build \
  --build-arg "NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX=${NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX}" \
  --build-arg "NITRO_PARTICIPANT_ID=${NITRO_PARTICIPANT_ID}" \
  --build-arg "NITRO_SIGNING_KEY_ID=${NITRO_SIGNING_KEY_ID}" \
  --tag "$DOCKER_IMAGE" "$ROOT/nitro/enclave"

nitro-cli build-enclave \
  --docker-uri "${EIF_NAME}:${EIF_VERSION}" \
  --output-file "${OUT}/${EIF_NAME}.eif" \
  --private-key "$ROOT/${EIF_SIGNING_KEY}" \
  --signing-certificate "$ROOT/${EIF_SIGNING_CERT}" \
  --name "$EIF_NAME" \
  --version "$EIF_VERSION" | tee "${OUT}/measurements.json"

nitro-cli describe-eif --eif-path "${OUT}/${EIF_NAME}.eif" | tee "${OUT}/eif-description.json"
