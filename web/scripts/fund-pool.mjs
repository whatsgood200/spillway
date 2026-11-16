// Moves test USDC from the demo account into InstantPool, so "cash now" can be tried on the live site.
// Run from web/:  node scripts/fund-pool.mjs 10     (amount in USDC)
import { maxUint256, parseAbi } from "viem";
import { A, account, pub, read, send } from "./lib/live.mjs";

const POOL = "0x15d5F39A464875634349a88c5E9F48D84f603207";
const poolAbi = parseAbi([
  "function deposit(uint256,address) returns (uint256)",
  "function idle() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);

const amount = BigInt(Math.round(Number(process.argv[2] ?? 10) * 1e6));
const cash = await read(A.usdc, "balanceOf", [account.address]);
if (cash < amount) throw new Error(`The demo account holds ${Number(cash) / 1e6} USDC, less than ${Number(amount) / 1e6}.`);

if ((await read(A.usdc, "allowance", [account.address, POOL])) < amount) await send(A.usdc, "approve", [POOL, maxUint256]);
const estimate = await pub.estimateContractGas({ address: POOL, abi: poolAbi, functionName: "deposit", args: [amount, account.address], account });
const { wallet } = await import("./lib/live.mjs");
const hash = await wallet.writeContract({ address: POOL, abi: poolAbi, functionName: "deposit", args: [amount, account.address], gas: (estimate * 3n) / 2n });
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`deposit reverted: ${hash}`);

const idle = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "idle" });
console.log(`Deposited ${Number(amount) / 1e6} USDC into the pool: ${hash}`);
console.log(`Pool cash now ${Number(idle) / 1e6} USDC. Demo account keeps ${Number(cash - amount) / 1e6} USDC for demo loops.`);
