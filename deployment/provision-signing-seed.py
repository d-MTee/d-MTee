#!/usr/bin/env python3
"""Create a KMS-encrypted Ed25519 seed bundle; never write plaintext seed to disk."""
import argparse
import base64
import json
import os
import sys
import uuid
from pathlib import Path

import boto3
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-id", required=True, help="KMS key ARN or alias")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION"))
    parser.add_argument("--output", required=True, type=Path, help="New metadata JSON path; must not exist")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("refusing to overwrite output; use a new protected path")

    kms = boto3.client("kms", region_name=args.region)
    seed = bytearray(kms.generate_random(NumberOfBytes=32)["Plaintext"])
    try:
        encrypted = kms.encrypt(KeyId=args.key_id, Plaintext=bytes(seed))["CiphertextBlob"]
        private_key = Ed25519PrivateKey.from_private_bytes(bytes(seed))
        public_key = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        result = {
            "keyId": str(uuid.uuid4()),
            "kmsKeyId": args.key_id,
            "ciphertextBlob": base64.b64encode(encrypted).decode("ascii"),
            "expectedPublicKeyHex": public_key.hex(),
        }
    finally:
        # Best effort: Python and the SDK may retain copies in process memory.
        for index in range(len(seed)):
            seed[index] = 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(result, output, separators=(",", ":"))
        output.write("\n")
    print(json.dumps({"keyId": result["keyId"], "expectedPublicKeyHex": result["expectedPublicKeyHex"], "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"provisioning failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1)
