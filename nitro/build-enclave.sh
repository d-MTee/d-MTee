#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/nitro"
ENCLAVE_DIR="${ROOT}/nitro/enclave"
IMAGE_NAME="${1:-dflow-nitro-signer}"
EIF_PATH="${OUT_DIR}/dflow-nitro-signer.eif"

print_usage() {
  cat <<EOF
Usage: $(basename "$0") [image-name]

Build the Nitro enclave container and package it into an EIF artifact.

Arguments:
  image-name   Docker image name to build and package (default: dflow-nitro-signer)

Examples:
  ./nitro/build-enclave.sh
  ./nitro/build-enclave.sh my-registry/dflow-nitro-signer

Required tools:
  - docker
  - nitro-cli
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[nitro] missing required dependency: $1" >&2
    exit 1
  }
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  print_usage
  exit 0
fi

require_cmd docker
require_cmd nitro-cli

if [[ ! -d "$ENCLAVE_DIR" ]]; then
  echo "[nitro] enclave source directory not found: $ENCLAVE_DIR" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "[nitro] building enclave image: ${IMAGE_NAME}:latest"
(
  cd "$ENCLAVE_DIR"
  docker build --tag "${IMAGE_NAME}:latest" .
)

echo "[nitro] packaging enclave into EIF"
nitro-cli build-enclave \
  --docker-uri "${IMAGE_NAME}:latest" \
  --output-file "$EIF_PATH"

sha384sum "$EIF_PATH"
echo "[nitro] EIF ready: $EIF_PATH"
