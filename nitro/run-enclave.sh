#!/usr/bin/env bash
set -euo pipefail
EIF=${1:-nitro/dflow-nitro-signer.eif}
nitro-cli run-enclave --eif-path "$EIF" --memory 1024 --cpu-count 2
nitro-cli describe-enclaves
