#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EIF_PATH="${1:-${ROOT}/nitro/dflow-nitro-signer.eif}"
MEMORY="${NITRO_MEMORY:-2048}"
CPU_COUNT="${NITRO_CPU_COUNT:-2}"

print_usage() {
  cat <<EOF
Usage: $(basename "$0") [eif-path]

Launch a local Nitro enclave from a packaged EIF artifact.

Arguments:
  eif-path   Path to the EIF file to run (default: ./nitro/dflow-nitro-signer.eif)

Environment variables:
  NITRO_MEMORY    Memory in MB (default: 2048)
  NITRO_CPU_COUNT CPU count (default: 2)

Examples:
  ./nitro/run-enclave.sh
  NITRO_MEMORY=4096 ./nitro/run-enclave.sh ./nitro/dflow-nitro-signer.eif

Required tools:
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

require_cmd nitro-cli

if [[ ! -f "$EIF_PATH" ]]; then
  echo "[nitro] EIF not found: $EIF_PATH" >&2
  echo "[nitro] build it first with: ./nitro/build-enclave.sh" >&2
  exit 1
fi

echo "[nitro] launching enclave: $EIF_PATH"
nitro-cli run-enclave \
  --eif-path "$EIF_PATH" \
  --memory "$MEMORY" \
  --cpu-count "$CPU_COUNT"

echo "[nitro] enclave status"
nitro-cli describe-enclaves
