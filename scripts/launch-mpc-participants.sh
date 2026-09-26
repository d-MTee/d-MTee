#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/mpc/frost-signer/target/release/dflow-frost-signer}"
PORT_BASE="${PORT_BASE:-9001}"
HOST="${HOST:-127.0.0.1}"
THRESHOLD="${THRESHOLD:-2}"
TOTAL="${TOTAL:-3}"

if [[ ! -f "$BIN" ]]; then
  echo "[mpc] signer binary not found: $BIN" >&2
  echo "[mpc] build it first with: cargo build --release --manifest-path mpc/frost-signer/Cargo.toml" >&2
  exit 1
fi

for i in $(seq 1 "$TOTAL"); do
  participant_id="p${i}"
  port=$((PORT_BASE + i - 1))
  echo "[mpc] starting ${participant_id} on ${HOST}:${port}"
  "$BIN" participant --participant-id "$participant_id" --host "$HOST" --port "$port" --threshold "$THRESHOLD" --total "$TOTAL" &
  PIDS+=("$!")
  sleep 0.2
done

trap 'kill ${PIDS[@]} 2>/dev/null || true' EXIT
wait
