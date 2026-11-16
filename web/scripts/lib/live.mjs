// Shared plumbing for the scripts that drive the live v2 deployment with the demo account.
// The demo key is read from web/.env.local and never printed.
import { mkdirSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, maxUint256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const A = {
  vault: "0xa24C70baa119B2430CbC2Fe770874fd3A10db1b0",
  callback: "0xfCA6031Dd3655CdB2B6D47F0A84F3e3e7c812C20",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  collateral: "0x9bdbfc3eC8659b3cB947162fa2a58a7837e4F806",
  reactor: "0x5adeA92852259009Fd5664F12aC13aBC74f9Fb77",
  system: "0x8888888888888888888888888888888888888888",
};
export const MARKET = "0x29c415df812658c358fbd137cb13745f337bdec8c043cb7f3247274a80115631";
const MIN_REACTOR_BALANCE = 400000000000000000n; // 0.4 lREACT: below this, scripts pause for a top-up.

const env = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const key = env.match(/^DEMO_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1];
if (!key) throw new Error("DEMO_PRIVATE_KEY missing from web/.env.local");
export const account = privateKeyToAccount(key);

export const abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function requestRedeem(uint256,address) returns (uint256,uint256,bool)",
  "function withdrawable() view returns (uint256)",
  "function queueLength() view returns (uint256)",
  "function nextRequestId() view returns (uint256)",
  "struct Request { address owner; address requester; uint256 assets; uint64 queuedAtMs; uint64 queuedBlock; uint64 settledAtMs; uint64 settledBlock; }",
  "function requestsSlice(uint256,uint256) view returns (Request[])",
  "function loopCount() view returns (uint256)",
  "struct Loop { uint256 originTxHash; uint64 originBlock; uint64 payoutBlock; uint64 paidAtMs; uint32 settled; uint256 assets; }",
  "function loopsSlice(uint256,uint256) view returns (Loop[])",
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function idToMarketParams(bytes32) view returns (MarketParams)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function supplyCollateral(MarketParams,uint256,address,bytes)",
  "function borrow(MarketParams,uint256,uint256,address,address) returns (uint256,uint256)",
  "function repay(MarketParams,uint256,uint256,address,bytes) returns (uint256,uint256)",
  "function debt(address) view returns (uint256)",
]);

export const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org", { retryCount: 4, retryDelay: 800 }) });
export const wallet = createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org", { retryCount: 4, retryDelay: 800 }) });
const lasna = createPublicClient({ transport: http("https://lasna-rpc.rnk.dev/", { retryCount: 4, retryDelay: 800 }) });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const read = (address, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

/**
 * Sends one transaction and waits for it. The public RPC sits behind several nodes, and an estimate from a node a
 * block behind can be too low for the path the transaction takes, so the estimate gets 50 percent headroom.
 */
export async function send(address, functionName, args) {
  const estimate = await pub.estimateContractGas({ address, abi, functionName, args, account });
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas: (estimate * 3n) / 2n + 60_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, block: Number(receipt.blockNumber) };
}

async function approveOnce(token, spender) {
  if ((await read(token, "allowance", [account.address, spender])) < 10n ** 30n) await send(token, "approve", [spender, maxUint256]);
}

export async function blockMs(block) {
  const b = await pub.request({ method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] });
  return b.timestampMs ? Number(BigInt(b.timestampMs)) : Number(BigInt(b.timestamp)) * 1000;
}

/** Waits until the reactive contract has gas money and no debt, pausing for a top-up when it runs low. */
export async function reactorReady() {
  for (let waited = 0; ; waited += 30) {
    const [balance, debt] = await Promise.all([
      lasna.getBalance({ address: A.reactor }),
      lasna.readContract({ address: A.system, abi, functionName: "debt", args: [A.reactor] }),
    ]);
    if (balance >= MIN_REACTOR_BALANCE && debt === 0n) return balance;
    if (waited === 0) console.log(`PAUSED: reactor has ${Number(balance) / 1e18} lREACT and debt ${debt}. Top it up to continue; checking every 30 s.`);
    if (waited > 3600) throw new Error("Reactor was not topped up within an hour. Stopping.");
    await sleep(30_000);
  }
}

/** What the demo borrower owes, rounded down so Morpho never sees an overpayment. */
export async function debtOwed() {
  const [, , borrowAssets, borrowShares] = await read(A.morpho, "market", [MARKET]);
  const [, myShares] = await read(A.morpho, "position", [MARKET, account.address]);
  return (myShares * (borrowAssets + 1n)) / (borrowShares + 1_000_000n);
}

/** Repays until the queue is empty. Payouts go back to the demo account, so it can repay in rounds. */
export async function clearQueue(params) {
  for (let round = 0; round < 10; round++) {
    if ((await read(A.vault, "queueLength")) === 0n) return;
    const owed = await debtOwed();
    const cash = await read(A.usdc, "balanceOf", [account.address]);
    const repay = owed < cash ? owed : cash;
    if (repay === 0n) throw new Error("queue is stuck and the demo account has nothing to repay with");
    console.log(`clearing a stuck queue: repaying ${Number(repay) / 1e6} USDC`);
    await send(A.morpho, "repay", [params, repay, 0n, account.address, "0x"]);
    for (let waited = 0; waited < 60_000; waited += 2000) {
      await sleep(2000);
      if ((await read(A.vault, "queueLength")) === 0n) break;
    }
  }
  if ((await read(A.vault, "queueLength")) > 0n) throw new Error("could not clear the queue");
}

/** One-time setup for the demo account: approvals and enough demo collateral to borrow against. */
export async function prepare() {
  const params = await read(A.morpho, "idToMarketParams", [MARKET]);
  await approveOnce(A.usdc, A.vault);
  await approveOnce(A.usdc, A.morpho);
  await approveOnce(A.collateral, A.morpho);
  const [, , collateral] = await read(A.morpho, "position", [MARKET, account.address]);
  if (collateral < 10n ** 20n) {
    await send(A.collateral, "mint", [account.address, 10n ** 21n]);
    await send(A.morpho, "supplyCollateral", [params, 10n ** 21n, account.address, "0x"]);
  }
  return params;
}

/** Fills the vault and puts one request at the front of an otherwise empty queue. Returns its id and size. */
export async function queueOne(params, amount) {
  await send(A.vault, "deposit", [amount, account.address]);
  const free = await read(A.vault, "withdrawable");
  if (free > 0n) await send(A.morpho, "borrow", [params, free, 0n, account.address, account.address]);
  const shares = await read(A.vault, "balanceOf", [account.address]);
  const requestId = Number(await read(A.vault, "nextRequestId"));
  const queued = await send(A.vault, "requestRedeem", [shares, account.address]);
  return { requestId, queued };
}

export function measurementFile(prefix) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = new URL("../../../measurements/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  return new URL(`${prefix}-${day}.jsonl`, dir);
}
