#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/deployment/keys"
mkdir -p "$DIR"
chmod 700 "$DIR"
if [[ -e "$DIR/eif-signing.key" || -e "$DIR/eif-signing.crt" ]]; then
  echo "Signing material already exists; refusing to overwrite." >&2
  exit 1
fi
openssl req -x509 -newkey rsa:3072 -sha384 -nodes -days 825 \
  -keyout "$DIR/eif-signing.key" \
  -out "$DIR/eif-signing.crt" \
  -subj "/CN=mini-dflow-nitro-eif"
chmod 600 "$DIR/eif-signing.key"
echo "Created EIF signing material in $DIR"
