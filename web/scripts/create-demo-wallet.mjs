// Creates the throwaway demo account used by /api/demo and writes its key to web/.env.local (git ignored).
// It prints the public address only. The key is for Base Sepolia test funds and must never hold anything of value.
// Run from web/:  node scripts/create-demo-wallet.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const file = new URL("../.env.local", import.meta.url);
const current = existsSync(file) ? readFileSync(file, "utf8") : "";
const existing = current.match(/^DEMO_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);

let address;
if (existing) {
  address = privateKeyToAccount(existing[1]).address;
  console.log("A demo account already exists. Nothing was changed.");
} else {
  const key = generatePrivateKey();
  address = privateKeyToAccount(key).address;
  const lines = current.trimEnd().split("\n").filter((line) => line && !line.startsWith("DEMO_PRIVATE_KEY=") && !line.startsWith("NEXT_PUBLIC_CHAIN_ADAPTER="));
  lines.push("NEXT_PUBLIC_CHAIN_ADAPTER=real", `DEMO_PRIVATE_KEY=${key}`);
  writeFileSync(file, lines.join("\n") + "\n");
  console.log("Created the demo account and wrote its key to web/.env.local.");
}
console.log(`Demo account address: ${address}`);
