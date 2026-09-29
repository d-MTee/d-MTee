#!/usr/bin/env python3
"""VSock-only KMS recipient broker. Configure ciphertext through a root-owned env file."""
import base64
import json
import os
import socket

import boto3
from botocore.config import Config

PORT = int(os.environ.get("NITRO_KMS_BROKER_PORT", "5001"))
ENCLAVE_CID = int(os.environ.get("NITRO_ENCLAVE_CID", "16"))
CLIENT_TIMEOUT_SECONDS = 5
MAX_REQUEST_BYTES = 128_000
CIPHERTEXT = base64.b64decode(os.environ["NITRO_KMS_CIPHERTEXT_BLOB"], validate=True)
kms = boto3.client(
    "kms",
    region_name=os.environ.get("AWS_REGION"),
    config=Config(connect_timeout=3, read_timeout=8, retries={"max_attempts": 1}),
)
server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
server.bind((socket.VMADDR_CID_ANY, PORT))
server.listen(16)

while True:
    client, peer = server.accept()
    with client:
        try:
            client.settimeout(CLIENT_TIMEOUT_SECONDS)
            if peer[0] != ENCLAVE_CID:
                raise ValueError("UNAUTHORIZED_VSOCK_CID")
            data = b""
            while b"\n" not in data and len(data) < MAX_REQUEST_BYTES:
                part = client.recv(min(4096, MAX_REQUEST_BYTES - len(data)))
                if not part:
                    break
                data += part
            if b"\n" not in data:
                raise ValueError("REQUEST_TOO_LARGE_OR_INCOMPLETE")
            request_line, trailing = data.split(b"\n", 1)
            if trailing:
                raise ValueError("TRAILING_REQUEST_DATA")
            request = json.loads(request_line)
            if request.get("op") != "kms-decrypt" or not isinstance(request.get("attestation"), str):
                raise ValueError("INVALID_REQUEST")
            if len(request["attestation"]) > MAX_REQUEST_BYTES:
                raise ValueError("ATTESTATION_TOO_LARGE")
            result = kms.decrypt(
                CiphertextBlob=CIPHERTEXT,
                Recipient={
                    "AttestationDocument": base64.b64decode(request["attestation"], validate=True),
                    "KeyEncryptionAlgorithm": "RSAES_OAEP_SHA_256",
                },
            )
            response = {"ok": True, "ciphertextForRecipient": base64.b64encode(result["CiphertextForRecipient"]).decode("ascii")}
        except Exception as exc:  # Error details are useful operationally; no key bytes are logged.
            response = {"ok": False, "error": type(exc).__name__}
        try:
            client.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode())
        except OSError:
            pass
