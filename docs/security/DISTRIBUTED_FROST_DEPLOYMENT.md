# Distributed FROST deployment and validation

This runbook covers the code path added for participant-local policy checks,
FROST share creation, signature verification, Solana transaction assembly, and
guarded submission. It does not replace a security review or the deployment
validation on separate infrastructure.

## Trust-domain layout

- Run exactly one `dflow-frost-signer participant` process per independently
  administered host/account. Do not run several participant IDs on one host
  for production validation.
- Give each participant a unique server certificate, private CA, participant
  peer certificate pin, KMS key/role, encrypted-key directory, and durable
  `MPC_SIGNING_NONCE_DIR` volume. The nonce volume must survive restarts and
  support exclusive file creation plus fsync.
- Use a dedicated coordinator client certificate accepted by the participants'
  pinned coordinator CA and leaf SHA-256. Configure `MPC_PEER_ENDPOINTS_JSON`
  on the API host with each participant endpoint and that participant's unique
  pinned CA. The Rust coordinator rejects duplicate selected participant CAs.
- Set the same policy-authority Ed25519 public key in the API's
  `POLICY_AUTHORITY_PUBLIC_KEY_HEX` and every participant's
  `MPC_POLICY_AUTHORITY_PUBLIC_KEY_HEX`. The policy signer must issue a distinct
  token for each participant; every token binds participant ID, request ID, key
  ID, approved transaction-message hash, approval, route/policy, wallet, chain,
  trade fields, expiry, and an independent random nonce.

## Build and configure

Build the signer with `cargo build --release --offline` in `mpc/frost-signer`.
Run each node with `dflow-frost-signer participant --participant-id pN
--threshold 2 --total 3`, with the mTLS, KMS key-store, and participant policy
environment variables described in [the MPC guide](../../mpc/README.md).

On the TypeScript API host, set `FROST_COORDINATOR_BIN` to the built signer
executable, `MPC_COORDINATOR_CERT_PEM` and `MPC_COORDINATOR_KEY_PEM` to the
coordinator identity, and `MPC_PEER_ENDPOINTS_JSON` to all participant gRPC
endpoints. The process passes the transaction and policy tokens to the Rust
coordinator over stdin; it does not place them in command-line arguments.
`FROST_THRESHOLD` must equal the DKG threshold. Set `FROST_EXPECTED_WALLET` to
the base58 group public key produced by DKG so `/execution/prepare` builds the
transaction for the FROST group rather than the Nitro key.

## Staged validation

1. Perform DKG across the three real hosts. Confirm each participant reports
   the same transcript and group key, and inspect each key-store directory to
   confirm it contains ciphertext only.
2. Use a devnet transaction whose required fee-payer public key is the FROST
   group public key. Submit `/sign/mpc` with all selected signer IDs, one
   signed policy token per participant, the exact serialized transaction
   message, and the corresponding unsigned transaction.
3. Confirm the API returns `verified: true`, `scheme: "FROST-Ed25519"`, and a
   serialized transaction whose signature verifies against the approved wallet
   and message. Confirm each participant's nonce journal has a consumed marker.
4. Replay the same tokens and then reuse one token with a different request ID;
   both must be rejected. Restart one signer and repeat with a fresh approved
   request to validate share recovery and durable replay state.
5. Submit only through `/execution/submit`, first on devnet with the live
   submission controls explicitly configured. Confirm on-chain status and
   approval reconciliation before considering any mainnet use.

Mainnet remains disabled by default. `ENABLE_DISTRIBUTED_FROST_MAINNET=true`
only bypasses that explicit gate; set it only after independent review of the
three-host results, participant/KMS policies, recovery, and transaction
reconciliation. This repository environment did not have three independent
hosts or AWS KMS credentials, so the deployment steps above remain unverified
here.
