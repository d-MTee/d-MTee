// Simulates Solana transactions and reads recent priority-fee data.
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { env } from "../config/env.js";
export async function simulateDevnet() {
  const c = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const payer = Keypair.generate();
  const bh = await c.getLatestBlockhash();
  const tx = new Transaction({
    recentBlockhash: bh.blockhash,
    feePayer: payer.publicKey,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 0,
    }),
  );

  const s = await (c.simulateTransaction as any)(tx, { sigVerify: false });

  return {
    err: s.value.err,
    logs: s.value.logs,
    units: s.value.unitsConsumed,
    blockhash: bh.blockhash,
  };
}
export async function priorityFees() {
  const c = new Connection(env.SOLANA_RPC_URL, "confirmed");
  return c.getRecentPrioritizationFees();
}
