import crypto from "node:crypto";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { env } from "../config/env.js";
import { markSubmissionConfirmed, markSubmissionFailed, markSubmissionAccepted, reserveSubmission } from "../security/approval.js";
import { txSubmitted, txConfirmed, txFailed } from "../observability/metrics.js";

const MAX_TRANSACTION_BYTES = 1232;
const COMMITMENT = "confirmed" as const;

export function assembleApprovedTransaction(input: {
  unsignedTransaction: unknown;
  signatureHex: unknown;
  expectedMessageHash: string;
  expectedWallet: string;
}) {
  if (typeof input.unsignedTransaction !== "string" || input.unsignedTransaction.length > 1700) throw new Error("TRANSACTION_INVALID");
  const raw = Buffer.from(input.unsignedTransaction, "base64");
  if (!raw.length || raw.length > MAX_TRANSACTION_BYTES || raw.toString("base64") !== input.unsignedTransaction) throw new Error("TRANSACTION_INVALID");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(raw); } catch { throw new Error("TRANSACTION_INVALID"); }
  const message = Buffer.from(tx.message.serialize());
  const messageHash = crypto.createHash("sha256").update(message).digest("hex");
  if (messageHash !== input.expectedMessageHash) throw new Error("APPROVAL_BINDING_MISMATCH");
  if (tx.message.header.numRequiredSignatures !== 1) throw new Error("UNSUPPORTED_TRANSACTION_SIGNERS");
  let signer: PublicKey;
  try { signer = new PublicKey(input.expectedWallet); } catch { throw new Error("APPROVAL_WALLET_INVALID"); }
  const signerIndex = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).findIndex((key) => key.equals(signer));
  if (signerIndex < 0 || signerIndex !== 0) throw new Error("TRANSACTION_FEE_PAYER_MISMATCH");
  if (typeof input.signatureHex !== "string" || !/^[a-f0-9]{128}$/i.test(input.signatureHex)) throw new Error("SIGNATURE_INVALID");
  const signature = Buffer.from(input.signatureHex, "hex");
  const verificationKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), signer.toBuffer()]),
    format: "der",
    type: "spki",
  });
  if (!crypto.verify(null, message, verificationKey, signature)) throw new Error("SIGNATURE_VERIFICATION_FAILED");
  tx.addSignature(signer, signature);
  return {
    serializedTransaction: Buffer.from(tx.serialize()).toString("base64"),
    transactionMessageHash: messageHash,
    walletId: signer.toBase58(),
  };
}

function rpcConnection() {
  if (!env.SOLANA_RPC_URL.startsWith("https://")) throw new Error("SOLANA_RPC_MUST_USE_HTTPS");
  if (!/^[a-f0-9]{64}$/i.test(env.SOLANA_EXPECTED_GENESIS_HASH)) throw new Error("SOLANA_EXPECTED_GENESIS_HASH_REQUIRED");
  return new Connection(env.SOLANA_RPC_URL, { commitment: COMMITMENT, confirmTransactionInitialTimeout: 10_000 });
}

function decodeAndValidate(input: unknown, expectedMessageHash: string, expectedWallet: string) {
  if (typeof input !== "string" || input.length > 1700) throw new Error("SIGNED_TRANSACTION_INVALID");
  const raw = Buffer.from(input, "base64");
  if (!raw.length || raw.length > MAX_TRANSACTION_BYTES || raw.toString("base64") !== input) throw new Error("SIGNED_TRANSACTION_INVALID");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(raw); } catch { throw new Error("SIGNED_TRANSACTION_INVALID"); }
  const message = Buffer.from(tx.message.serialize());
  const messageHash = crypto.createHash("sha256").update(message).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedMessageHash) || messageHash !== expectedMessageHash) throw new Error("APPROVAL_BINDING_MISMATCH");
  const required = tx.message.header.numRequiredSignatures;
  if (required < 1 || tx.signatures.length !== required) throw new Error("TRANSACTION_SIGNATURES_INVALID");
  let wallet: PublicKey;
  try { wallet = new PublicKey(expectedWallet); } catch { throw new Error("APPROVAL_WALLET_INVALID"); }
  if (!tx.message.staticAccountKeys[0]?.equals(wallet)) throw new Error("TRANSACTION_FEE_PAYER_MISMATCH");
  if (tx.signatures.some((signature) => signature.length !== 64 || signature.every((byte) => byte === 0))) throw new Error("TRANSACTION_SIGNATURES_INCOMPLETE");
  return { tx, raw, messageHash, blockhash: tx.message.recentBlockhash };
}

export async function submitApprovedTransaction(input: {
  approvalId: string;
  serializedTransaction: unknown;
  expectedMessageHash: string;
  expectedWallet: string;
  lastValidBlockHeight: number;
  actorPrincipalId: string;
}) {
  if (env.ENABLE_LIVE_SUBMISSION !== "true") throw new Error("LIVE_SUBMISSION_DISABLED");
  const { tx, raw, messageHash, blockhash } = decodeAndValidate(input.serializedTransaction, input.expectedMessageHash, input.expectedWallet);
  if (!Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight <= 0) throw new Error("LAST_VALID_BLOCK_HEIGHT_REQUIRED");
  const connection = rpcConnection();
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash.toLowerCase() !== env.SOLANA_EXPECTED_GENESIS_HASH.toLowerCase()) throw new Error("SOLANA_RPC_CLUSTER_MISMATCH");
  const currentBlockHeight = await connection.getBlockHeight(COMMITMENT);
  if (input.lastValidBlockHeight <= currentBlockHeight || input.lastValidBlockHeight > currentBlockHeight + 200) throw new Error("TRANSACTION_BLOCKHASH_EXPIRED_OR_INVALID");
  const blockhashValid = await connection.isBlockhashValid(blockhash, { commitment: COMMITMENT });
  if (!blockhashValid.value) throw new Error("TRANSACTION_BLOCKHASH_EXPIRED_OR_INVALID");

  const simulation = await connection.simulateTransaction(tx, { commitment: COMMITMENT, sigVerify: true, replaceRecentBlockhash: false });
  if (simulation.value.err) throw new Error("TRANSACTION_SIMULATION_FAILED");

  const reservation = await reserveSubmission(input.approvalId, raw.toString("base64"), messageHash, input.actorPrincipalId);
  if (reservation.alreadySubmitted && reservation.approval.transactionSignature) {
    const status = await transactionStatus(reservation.approval);
    return { ...status, confirmed: status.status === "confirmed" };
  }

  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: COMMITMENT,
    maxRetries: 3,
  });
  const previouslyAccepted = await markSubmissionAccepted(input.approvalId, signature);
  if (!previouslyAccepted) txSubmitted.inc();

  let confirmed = false;
  try {
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight: input.lastValidBlockHeight }, COMMITMENT);
    if (result.value.err) {
      const newlyFailed = await markSubmissionFailed(input.approvalId, signature, "ON_CHAIN_TRANSACTION_FAILED");
      if (newlyFailed) txFailed.inc();
      throw new Error("ON_CHAIN_TRANSACTION_FAILED");
    }
    confirmed = true;
    const newlyConfirmed = await markSubmissionConfirmed(input.approvalId, signature);
    if (newlyConfirmed) txConfirmed.inc();
  } catch (error) {
    if (error instanceof Error && error.message === "ON_CHAIN_TRANSACTION_FAILED") throw error;
    // Submission was accepted by the RPC. Leave it SUBMITTED so a later status poll can reconcile it.
  }
  return { signature, status: confirmed ? "confirmed" : "submitted", confirmed };
}

export async function transactionStatus(approval: Record<string, string>) {
  const signature = approval.transactionSignature;
  if (!signature) return { approvalId: approval.id, status: approval.state.toLowerCase() };
  const connection = rpcConnection();
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash.toLowerCase() !== env.SOLANA_EXPECTED_GENESIS_HASH.toLowerCase()) throw new Error("SOLANA_RPC_CLUSTER_MISMATCH");
  const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = statuses.value[0];
  if (status?.err) {
    const newlyFailed = await markSubmissionFailed(approval.id, signature, "ON_CHAIN_TRANSACTION_FAILED");
    if (newlyFailed) txFailed.inc();
    return { approvalId: approval.id, signature, status: "failed", error: "ON_CHAIN_TRANSACTION_FAILED" };
  }
  if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
    const newlyConfirmed = await markSubmissionConfirmed(approval.id, signature);
    if (newlyConfirmed) txConfirmed.inc();
    return { approvalId: approval.id, signature, status: "confirmed", slot: status.slot };
  }
  if (!status && approval.lastValidBlockHeight && Number(approval.lastValidBlockHeight) < await connection.getBlockHeight(COMMITMENT)) {
    const newlyFailed = await markSubmissionFailed(approval.id, signature, "TRANSACTION_EXPIRED");
    if (newlyFailed) txFailed.inc();
    return { approvalId: approval.id, signature, status: "failed", error: "TRANSACTION_EXPIRED" };
  }
  return { approvalId: approval.id, signature, status: "submitted", slot: status?.slot };
}
