// Runs N full loops on the live v2 deployment with the demo account, one after another:
// demo lender deposits, demo borrower borrows everything, lender queues a withdrawal, borrower repays,
// then the script only watches until Reactive Network pays the queue. It never calls settle itself.
// Latency is read back from SpillwayCallback storage, not timed by this script.
//
// Run from web/:  node scripts/run-loops.mjs 200
// Output: one JSON line per loop in ../measurements/loops-<date>.jsonl, plus a summary at the end.
// The demo key is read from web/.env.local and never printed.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, maxUint256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = "https://sepolia.base.org";
const LASNA = "https://lasna-rpc.rnk.dev/";
const A = {
  vault: "0xa24C70baa119B2430CbC2Fe770874fd3A10db1b0",
  callback: "0xfCA6031Dd3655CdB2B6D47F0A84F3e3e7c812C20",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  collateral: "0x9bdbfc3eC8659b3cB947162fa2a58a7837e4F806",
  reactor: "0x5adeA92852259009Fd5664F12aC13aBC74f9Fb77",
  system: "0x8888888888888888888888888888888888888888",
};
const MARKET = "0x29c415df812658c358fbd137cb13745f337bdec8c043cb7f3247274a80115631";
const MIN_REACTOR_BALANCE = 400000000000000000n; // 0.4 lREACT: below this the script pauses for a top-up.
const LOOP_TIMEOUT_MS = 90_000;

const total = Number(process.argv[2] ?? 200);
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = env.match(/^DEMO_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1];
if (!key) throw new Error("DEMO_PRIVATE_KEY missing from web/.env.local");
const account = privateKeyToAccount(key);

const abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function requestRedeem(uint256,address) returns (uint256,uint256,bool)",
  "function withdrawable() view returns (uint256)",
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

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC, { retryCount: 4, retryDelay: 800 }) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC, { retryCount: 4, retryDelay: 800 }) });
const lasna = createPublicClient({ transport: http(LASNA, { retryCount: 4, retryDelay: 800 }) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (address, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

async function send(address, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, block: Number(receipt.blockNumber) };
}

async function approveOnce(token, spender) {
  if ((await read(token, "allowance", [account.address, spender])) < 10n ** 30n) await send(token, "approve", [spender, maxUint256]);
}

async function blockMs(block) {
  const b = await pub.request({ method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] });
  return b.timestampMs ? Number(BigInt(b.timestampMs)) : Number(BigInt(b.timestamp)) * 1000;
}

async function reactorReady() {
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

const day = new Date().toISOString().slice(0, 10);
const outDir = new URL("../../measurements/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const outFile = new URL(`loops-${day}.jsonl`, outDir);

const params = await read(A.morpho, "idToMarketParams", [MARKET]);
await approveOnce(A.usdc, A.vault);
await approveOnce(A.usdc, A.morpho);
await approveOnce(A.collateral, A.morpho);
const [, , collateral] = await read(A.morpho, "position", [MARKET, account.address]);
if (collateral < 10n ** 20n) {
  await send(A.collateral, "mint", [account.address, 10n ** 21n]);
  await send(A.morpho, "supplyCollateral", [params, 10n ** 21n, account.address, "0x"]);
}

console.log(`Demo account ${account.address}. Running ${total} loops. Writing ${outFile.pathname}`);
const latencies = [];
let failures = 0;

for (let i = 1; i <= total; i++) {
  try {
    await reactorReady();
    // 1.00 to 3.00 USDC, varied so the record is not one repeated number.
    const amount = 1_000_000n + BigInt(Math.floor(Math.random() * 21)) * 100_000n;
    const before = Number(await read(A.callback, "loopCount"));

    await send(A.vault, "deposit", [amount, account.address]);
    const free = await read(A.vault, "withdrawable");
    if (free > 0n) await send(A.morpho, "borrow", [params, free, 0n, account.address, account.address]);
    const shares = await read(A.vault, "balanceOf", [account.address]);
    const queued = await send(A.vault, "requestRedeem", [shares, account.address]);

    // Repay exactly what the queue needs, rounded down so Morpho never sees an overpayment.
    const [, , borrowAssets, borrowShares] = await read(A.morpho, "market", [MARKET]);
    const [, myShares] = await read(A.morpho, "position", [MARKET, account.address]);
    const owed = (myShares * (borrowAssets + 1n)) / (borrowShares + 1_000_000n);
    const repay = amount < owed ? amount : owed;
    const repaid = await send(A.morpho, "repay", [params, repay, 0n, account.address, "0x"]);

    // Watch only. The payout must come from Reactive Network.
    const started = Date.now();
    let loop = null;
    while (Date.now() - started < LOOP_TIMEOUT_MS) {
      await sleep(1500);
      const count = Number(await read(A.callback, "loopCount"));
      if (count > before) {
        [loop] = await read(A.callback, "loopsSlice", [BigInt(count - 1), 1n]);
        break;
      }
    }
    if (!loop) throw new Error(`no payout within ${LOOP_TIMEOUT_MS / 1000} s after repay ${repaid.hash}`);

    const originMs = await blockMs(Number(loop.originBlock));
    const latencyMs = Number(loop.paidAtMs) - originMs;
    latencies.push(latencyMs);
    const row = {
      loop: Number(await read(A.callback, "loopCount")),
      amount: Number(repay) / 1e6,
      queueTx: queued.hash,
      repayTx: repaid.hash,
      originBlock: Number(loop.originBlock),
      payoutBlock: Number(loop.payoutBlock),
      latencyMs,
      blocks: Number(loop.payoutBlock) - Number(loop.originBlock),
      at: new Date().toISOString(),
    };
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    console.log(`loop ${i}/${total}: ${latencyMs} ms (${row.blocks} blocks)`);
  } catch (cause) {
    failures++;
    appendFileSync(outFile, JSON.stringify({ failed: true, run: i, error: String(cause?.shortMessage ?? cause?.message ?? cause), at: new Date().toISOString() }) + "\n");
    console.log(`loop ${i}/${total}: FAILED ${cause?.shortMessage ?? cause?.message ?? cause}`);
    if (failures >= 10) {
      console.log("Ten failures. Stopping so the cause can be looked at.");
      break;
    }
    await sleep(5000);
  }
}

const sorted = [...latencies].sort((a, b) => a - b);
const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
console.log(
  sorted.length
    ? `DONE: ${sorted.length} loops, ${failures} failed. p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, p99 ${at(0.99)} ms, min ${sorted[0]} ms, max ${sorted[sorted.length - 1]} ms`
    : `DONE: no successful loops, ${failures} failed.`,
);
