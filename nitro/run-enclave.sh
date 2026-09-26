#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EIF="${1:-${ROOT}/nitro/dflow-nitro-signer.eif}"
MEMORY="${NITRO_MEMORY:-2048}"
CPU_COUNT="${NITRO_CPU_COUNT:-2}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required dependency: $1" >&2
    exit 1
  }
}

require_cmd nitro-cli

if [[ ! -f "$EIF" ]]; then
  echo "EIF not found: $EIF" >&2
  echo "Build it first with: ./nitro/build-enclave.sh" >&2
  exit 1
fi

echo "[nitro] launching enclave: $EIF"
nitro-cli run-enclave \
  --eif-path "$EIF" \
  --memory "$MEMORY" \
  --cpu-count "$CPU_COUNT"

echo "[nitro] enclave status"
nitro-cli describe-enclaves
