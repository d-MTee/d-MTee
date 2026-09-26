# Security model

## Security boundaries

1. API/router is untrusted with respect to private key material.
2. MPC coordinator is untrusted with respect to individual FROST shares.
3. Parent EC2 is untrusted with respect to plaintext enclave secrets.
4. Nitro enclave is the signing trust boundary.
5. AWS KMS is the external authorization point for encrypted secret release.
6. EIF signing key is a separate high-value CI/CD credential.

## Request binding

A signing request should be bound to a canonical digest containing:

```text
request_id
nonce
expiry
chain_id
wallet_id
key_epoch
transaction_message_hash
route_digest
risk_policy_digest
approval_digest
```

The enclave should sign the canonical digest or canonical transaction message, never arbitrary caller-supplied JSON.

## Anti-replay

Reject:

- expired requests
- previously consumed nonces
- duplicate request IDs
- wrong key epoch
- wrong chain ID
- mismatched transaction hash
- mismatched policy/approval digest

## KMS policy

The reference deployment binds KMS access to:

```text
PCR3 = SHA384(parent IAM role ARN)
PCR8 = EIF signing certificate measurement
```

AWS also supports PCR0/ImageSha384 and other PCR condition keys. The policy can be tightened further for a particular deployment.

## Secret handling

No plaintext key share belongs in the EIF. Store only ciphertext outside the enclave. Decrypt after attestation inside the enclave and zeroize plaintext buffers after use where practical.

## Threats that require separate controls

- CI/CD compromise: protect the EIF signing key and require release approval.
- AWS account compromise: use separate accounts for participants and restrict IAM.
- Coordinator compromise: require policy verification in each enclave.
- Insider abuse: separate duties between release, key ceremony and operations.
- Availability attacks: multi-region RPC, participant redundancy and circuit breakers.
