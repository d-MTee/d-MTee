#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts"
mkdir -p "$OUT"

: "${EIF_NAME:=mini-dflow-signer}"
: "${EIF_VERSION:=5.0.0}"
: "${EIF_SIGNING_KEY:=deployment/keys/eif-signing.key}"
: "${EIF_SIGNING_CERT:=deployment/keys/eif-signing.crt}"

if ! command -v nitro-cli >/dev/null 2>&1; then
  echo "nitro-cli is required. Run this on a Nitro-enabled parent or another host with Nitro CLI." >&2
  exit 1
fi

if [[ ! -f "$EIF_SIGNING_KEY" || ! -f "$EIF_SIGNING_CERT" ]]; then
  echo "Missing EIF signing key/certificate. Run deployment/create-eif-cert.sh first." >&2
  exit 1
fi

nitro-cli build-enclave \
  --docker-dir "$ROOT/nitro/enclave" \
  --docker-uri "${EIF_NAME}:${EIF_VERSION}" \
  --output-file "${OUT}/${EIF_NAME}.eif" \
  --private-key "$ROOT/${EIF_SIGNING_KEY}" \
  --signing-certificate "$ROOT/${EIF_SIGNING_CERT}" \
  --name "$EIF_NAME" \
  --version "$EIF_VERSION" | tee "${OUT}/measurements.json"

nitro-cli describe-eif --eif-path "${OUT}/${EIF_NAME}.eif" | tee "${OUT}/eif-description.json"
