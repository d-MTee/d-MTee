#!/usr/bin/env bash
set -e
curl -fsS http://localhost:8080/health >/dev/null
curl -fsS 'http://localhost:8080/quote?amount=10' >/dev/null
curl -fsS 'http://localhost:8080/route/split?amount=100' >/dev/null
curl -fsS 'http://localhost:8080/route/jit?amount=100' >/dev/null
echo 'smoke ok'
