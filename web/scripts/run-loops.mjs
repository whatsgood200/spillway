// Runs N full loops on the live v2 deployment with the demo account, one after another:
// demo lender deposits, demo borrower borrows everything, lender queues a withdrawal, borrower repays,
// then the script only watches until Reactive Network pays the queue. It never calls settle itself.
// Latency is read back from SpillwayCallback storage, not timed by this script.
//
// Run from web/:  node scripts/run-loops.mjs 200
// Output: one JSON line per loop in ../measurements/loops-<date>.jsonl, plus a summary at the end.
import { appendFileSync } from "node:fs";
import { A, account, blockMs, clearQueue, debtOwed, measurementFile, prepare, queueOne, read, reactorReady, send, sleep } from "./lib/live.mjs";

const LOOP_TIMEOUT_MS = 90_000;
const total = Number(process.argv[2] ?? 200);
const outFile = measurementFile("loops");
const params = await prepare();

console.log(`Demo account ${account.address}. Running ${total} loops. Writing ${outFile.pathname}`);
const latencies = [];
let failures = 0;

for (let i = 1; i <= total; i++) {
  try {
    await reactorReady();
    await clearQueue(params);
    // 1.00 to 3.00 USDC, varied so the record is not one repeated number.
    const amount = 1_000_000n + BigInt(Math.floor(Math.random() * 21)) * 100_000n;
    const before = Number(await read(A.callback, "loopCount"));
    const { queued } = await queueOne(params, amount);

    // Repay everything owed, so nothing a failed step left behind can carry into the next loop.
    const owed = await debtOwed();
    const cash = await read(A.usdc, "balanceOf", [account.address]);
    const repay = owed < cash ? owed : cash;
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
