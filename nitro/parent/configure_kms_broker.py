#!/usr/bin/env python3
"""Fetch participant KMS ciphertext from SSM and write a root-only broker env file."""
import base64
import os
import re
import sys
from pathlib import Path

import boto3


def main() -> int:
    if len(sys.argv) != 3:
        raise ValueError("usage: configure_kms_broker.py <parameter-name> <region>")
    parameter, region = sys.argv[1:]
    if not re.fullmatch(r"/mini-dflow/[a-zA-Z0-9_-]{1,32}/kms-ciphertext", parameter):
        raise ValueError("invalid participant parameter path")
    if not re.fullmatch(r"[a-z0-9-]+", region):
        raise ValueError("invalid AWS region")
    ciphertext = boto3.client("ssm", region_name=region).get_parameter(
        Name=parameter, WithDecryption=True
    )["Parameter"]["Value"]
    base64.b64decode(ciphertext, validate=True)
    target = Path("/etc/mini-dflow/kms-broker.env")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(f"NITRO_KMS_CIPHERTEXT_BLOB={ciphertext}\n")
        output.write(f"AWS_REGION={region}\nNITRO_ENCLAVE_CID=16\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"broker configuration failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1)
