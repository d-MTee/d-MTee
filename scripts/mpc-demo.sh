#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cd mpc/frost-signer
cargo run --release -- demo "$(printf 'mini-dflow real MPC test' | base64 -w0)"
