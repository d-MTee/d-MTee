#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${1:-dflow-nitro-signer}"
OUT_DIR="${ROOT}/nitro"
ENCLAVE_DIR="${ROOT}/nitro/enclave"
EIF_PATH="${OUT_DIR}/dflow-nitro-signer.eif"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required dependency: $1" >&2
    exit 1
  }
}

require_cmd docker
require_cmd nitro-cli

if [[ ! -d "$ENCLAVE_DIR" ]]; then
  echo "Enclave source directory not found: $ENCLAVE_DIR" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "[nitro] building enclave image: ${IMAGE}:latest"
(
  cd "$ENCLAVE_DIR"
  docker build --tag "${IMAGE}:latest" .
)

echo "[nitro] packaging enclave into EIF"
nitro-cli build-enclave \
  --docker-uri "${IMAGE}:latest" \
  --output-file "$EIF_PATH"

sha384sum "$EIF_PATH"
echo "[nitro] EIF ready: $EIF_PATH"
