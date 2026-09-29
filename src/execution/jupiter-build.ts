import crypto from "node:crypto";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { env } from "../config/env.js";

const MAX_TRANSACTION_BYTES = 1232;
const MAX_INSTRUCTIONS = 64;
const MAX_INSTRUCTION_DATA_BYTES = 16_384;
const COMPUTE_UNIT_LIMIT = 1_400_000;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type ApiInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

function base58Encode(bytes: Uint8Array) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58[remainder] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function sha256(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseInstruction(value: unknown): TransactionInstruction {
  if (!value || typeof value !== "object") throw new Error("JUPITER_INSTRUCTION_INVALID");
  const candidate = value as ApiInstruction;
  if (typeof candidate.programId !== "string" || typeof candidate.data !== "string" || !Array.isArray(candidate.accounts)) throw new Error("JUPITER_INSTRUCTION_INVALID");
  const data = Buffer.from(candidate.data, "base64");
  if (data.length > MAX_INSTRUCTION_DATA_BYTES || data.toString("base64") !== candidate.data) throw new Error("JUPITER_INSTRUCTION_INVALID");
  return new TransactionInstruction({
    programId: new PublicKey(candidate.programId),
    keys: candidate.accounts.map((account) => {
      if (!account || typeof account.pubkey !== "string" || typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") throw new Error("JUPITER_ACCOUNT_META_INVALID");
      return { pubkey: new PublicKey(account.pubkey), isSigner: account.isSigner, isWritable: account.isWritable };
    }),
    data,
  });
}

function parseLookupTables(value: unknown): AddressLookupTableAccount[] {
  if (value == null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("JUPITER_LOOKUP_TABLES_INVALID");
  return Object.entries(value as Record<string, unknown>).map(([key, rawAddresses]) => {
    if (!Array.isArray(rawAddresses) || rawAddresses.length > 256 || rawAddresses.some((address) => typeof address !== "string")) throw new Error("JUPITER_LOOKUP_TABLES_INVALID");
    return new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: rawAddresses.map((address) => new PublicKey(address as string)),
      },
    });
  });
}

function rpcConnection() {
  if (!env.SOLANA_RPC_URL.startsWith("https://")) throw new Error("SOLANA_RPC_MUST_USE_HTTPS");
  return new Connection(env.SOLANA_RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 10_000 });
}

export async function prepareJupiterTransaction(input: {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps: number;
  wallet: string;
}) {
  if (!env.JUPITER_API_KEY) throw new Error("JUPITER_API_KEY_REQUIRED");
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > env.MAX_SLIPPAGE_BPS) throw new Error("TRADE_LIMIT_INVALID");
  const wallet = new PublicKey(input.wallet);
  const inputMint = new PublicKey(input.inputMint).toBase58();
  const outputMint = new PublicKey(input.outputMint).toBase58();
  if (inputMint === outputMint) throw new Error("INPUT_AND_OUTPUT_MINT_MUST_DIFFER");

  const url = new URL("https://api.jup.ag/swap/v2/build");
  url.search = new URLSearchParams({ inputMint, outputMint, amount: String(input.amount), taker: wallet.toBase58(), slippageBps: String(input.slippageBps) }).toString();
  const response = await fetch(url, { headers: { "x-api-key": env.JUPITER_API_KEY }, signal: AbortSignal.timeout(env.RPC_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`JUPITER_BUILD_FAILED_${response.status}`);
  const build: any = await response.json();

  if (build.inputMint !== inputMint || build.outputMint !== outputMint || String(build.inAmount) !== String(input.amount) || Number(build.slippageBps) !== input.slippageBps) throw new Error("JUPITER_BUILD_BINDING_MISMATCH");
  if (!Array.isArray(build.routePlan) || build.routePlan.length === 0 || !Array.isArray(build.setupInstructions) || !Array.isArray(build.computeBudgetInstructions) || !Array.isArray(build.otherInstructions) || !build.swapInstruction || !build.blockhashWithMetadata) throw new Error("JUPITER_BUILD_RESPONSE_INVALID");
  const instructionValues = [
    ...build.setupInstructions,
    build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...build.otherInstructions,
    ...(build.tipInstruction ? [build.tipInstruction] : []),
  ];
  if (instructionValues.length + build.computeBudgetInstructions.length + 1 > MAX_INSTRUCTIONS) throw new Error("JUPITER_INSTRUCTION_LIMIT_EXCEEDED");
  const blockhashBytes = build.blockhashWithMetadata.blockhash;
  const lastValidBlockHeight = Number(build.blockhashWithMetadata.lastValidBlockHeight);
  if (!Array.isArray(blockhashBytes) || blockhashBytes.length !== 32 || blockhashBytes.some((byte: unknown) => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255) || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error("JUPITER_BLOCKHASH_INVALID");
  const recentBlockhash = base58Encode(Uint8Array.from(blockhashBytes));
  const lookupTables = parseLookupTables(build.addressesByLookupTableAddress);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ...build.computeBudgetInstructions.map(parseInstruction),
    ...instructionValues.map(parseInstruction),
  ];
  const message = new TransactionMessage({ payerKey: wallet, recentBlockhash, instructions }).compileToV0Message(lookupTables);
  if (message.header.numRequiredSignatures !== 1 || !message.staticAccountKeys[0]?.equals(wallet)) throw new Error("UNSUPPORTED_TRANSACTION_SIGNERS");
  const transaction = new VersionedTransaction(message);
  const serialized = Buffer.from(transaction.serialize());
  if (serialized.length > MAX_TRANSACTION_BYTES) throw new Error("TRANSACTION_SIZE_LIMIT_EXCEEDED");

  if (!/^[a-f0-9]{64}$/i.test(env.SOLANA_EXPECTED_GENESIS_HASH)) throw new Error("SOLANA_EXPECTED_GENESIS_HASH_REQUIRED");
  const connection = rpcConnection();
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash.toLowerCase() !== env.SOLANA_EXPECTED_GENESIS_HASH.toLowerCase()) throw new Error("SOLANA_RPC_CLUSTER_MISMATCH");
  const currentHeight = await connection.getBlockHeight("confirmed");
  if (lastValidBlockHeight <= currentHeight || lastValidBlockHeight > currentHeight + 200) throw new Error("TRANSACTION_BLOCKHASH_EXPIRED_OR_INVALID");
  if (!(await connection.isBlockhashValid(recentBlockhash, { commitment: "confirmed" })).value) throw new Error("TRANSACTION_BLOCKHASH_EXPIRED_OR_INVALID");
  const simulation = await connection.simulateTransaction(transaction, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
  if (simulation.value.err) throw new Error("TRANSACTION_SIMULATION_FAILED");

  const transactionMessage = Buffer.from(message.serialize());
  const routeHash = sha256(JSON.stringify(build.routePlan));
  const policy = { version: 1, chainId: env.SOLANA_CLUSTER_ID, walletId: wallet.toBase58(), inputMint, outputMint, amount: String(input.amount), maxSlippageBps: input.slippageBps, routeHash };
  const policyHash = sha256(JSON.stringify(policy));
  return {
    inputMint,
    outputMint,
    amount: input.amount,
    outAmount: String(build.outAmount ?? ""),
    otherAmountThreshold: String(build.otherAmountThreshold ?? ""),
    maxSlippageBps: input.slippageBps,
    routeHash,
    policyHash,
    transactionMessageHash: sha256(transactionMessage),
    transactionMessage: transactionMessage.toString("base64"),
    unsignedTransaction: serialized.toString("base64"),
    lastValidBlockHeight,
    walletId: wallet.toBase58(),
    chainId: env.SOLANA_CLUSTER_ID,
    routePlan: build.routePlan,
    simulatedUnits: simulation.value.unitsConsumed ?? null,
  };
}
