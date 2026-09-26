#!/usr/bin/env bash
set -euo pipefail
IMAGE=${1:-dflow-nitro-signer}
cd "$(dirname "$0")/enclave"
docker build -t "$IMAGE" .
nitro-cli build-enclave --docker-uri "$IMAGE:latest" --output-file ../dflow-nitro-signer.eif
sha384sum ../dflow-nitro-signer.eif
