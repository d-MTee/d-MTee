#!/usr/bin/env python3
"""VSock-only KMS recipient broker. Configure ciphertext through a root-owned env file."""
import base64
import json
import os
import socket

import boto3

PORT = int(os.environ.get("NITRO_KMS_BROKER_PORT", "5001"))
ENCLAVE_CID = int(os.environ.get("NITRO_ENCLAVE_CID", "16"))
CIPHERTEXT = base64.b64decode(os.environ["NITRO_KMS_CIPHERTEXT_BLOB"], validate=True)
kms = boto3.client("kms", region_name=os.environ.get("AWS_REGION"))
server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
server.bind((socket.VMADDR_CID_ANY, PORT))
server.listen(16)

while True:
    client, peer = server.accept()
    with client:
        try:
            if peer[0] != ENCLAVE_CID:
                raise ValueError("UNAUTHORIZED_VSOCK_CID")
            data = b""
            while b"\n" not in data and len(data) < 128_000:
                part = client.recv(4096)
                if not part:
                    break
                data += part
            request = json.loads(data.split(b"\n", 1)[0])
            if request.get("op") != "kms-decrypt" or not isinstance(request.get("attestation"), str):
                raise ValueError("INVALID_REQUEST")
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
        client.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode())
