#!/usr/bin/env python3
"""Minimal stdin/stdout AWS KMS adapter. Never logs plaintext or ciphertext."""
import base64
import json
import os
import sys

MAX_INPUT = 16_384
MAX_PLAINTEXT = 4096
CONTEXT_KEYS = {
    "application", "participant_id", "key_id", "transcript_hash",
    "threshold", "total_participants", "package_type",
}


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("REQUEST_TOO_LARGE")
    request = json.loads(raw)
    operation = request.get("operation")
    payload = base64.b64decode(request.get("payload", ""), validate=True)
    context = request.get("encryption_context")
    if operation not in ("encrypt", "decrypt") or not isinstance(context, dict):
        raise ValueError("INVALID_REQUEST")
    if set(context) != CONTEXT_KEYS or any(not isinstance(v, str) or not v for v in context.values()):
        raise ValueError("INVALID_ENCRYPTION_CONTEXT")
    if context["application"] != "mini-dflow-frost-share-v1" or context["package_type"] not in ("private", "public"):
        raise ValueError("INVALID_ENCRYPTION_CONTEXT")
    import boto3
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    client = boto3.client("kms", region_name=region) if region else boto3.client("kms")
    key_id = sys.argv[1]
    if operation == "encrypt":
        if len(payload) > MAX_PLAINTEXT:
            raise ValueError("PLAINTEXT_TOO_LARGE")
        result = client.encrypt(KeyId=key_id, Plaintext=payload, EncryptionContext=context)["CiphertextBlob"]
    else:
        result = client.decrypt(KeyId=key_id, CiphertextBlob=payload, EncryptionContext=context)["Plaintext"]
        if len(result) > MAX_PLAINTEXT:
            raise ValueError("PLAINTEXT_TOO_LARGE")
    sys.stdout.write(json.dumps({"ok": True, "result": base64.b64encode(result).decode("ascii")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Emit a bounded symbolic failure only; AWS exceptions may contain identifiers.
        code = getattr(exc, "response", {}).get("Error", {}).get("Code", "KMS_HELPER_ERROR")
        sys.stdout.write(json.dumps({"ok": False, "error": str(code)[:80]}))
        # A structured response lets the Rust caller report failure without
        # exposing helper stderr or provider exception text.
        sys.exit(0)
