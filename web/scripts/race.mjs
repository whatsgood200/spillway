// The race experiment: does freed liquidity reach the queue, or does a competing borrower take it first?
//
// Each trial puts one withdrawal at the front of the queue in a fully lent vault, then the borrower repays.
// That repayment is the only cash in the market. A competing borrower then tries to borrow exactly that cash,
// starting a chosen delay after the repayment is seen. Whoever lands first gets it:
// - the queue wins if Reactive Network's callback pays the request before the competitor's borrow lands
//   (the borrow then reverts with "insufficient liquidity");
// - the competitor wins if its borrow lands first (the request stays queued until the next repayment).
// The competitor is our demo account, labelled as such. Results are judged from the chain: the competitor's
// receipt status and the request's settled block in QueueVault storage.
//
// Run from web/:  node scripts/race.mjs 5     (trials per delay; delays are interleaved, not run in blocks)
// Output: ../measurements/race-<date>.jsonl, one line per trial, and a summary by measured lag.
import { appendFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { A, abi, account, blockMs, clearQueue, debtOwed, measurementFile, prepare, pub, queueOne, read, reactorReady, sleep, wallet } from "./lib/live.mjs";

const DELAYS_MS = [0, 400, 800, 1200, 1600, 2000, 3000, 5000];
const AMOUNT = 1_500_000n;
const COMPETITOR_GAS = 450_000n; // Fixed: an estimate would fail once the queue has already taken the cash.
const perDelay = Number(process.argv[2] ?? 5);
const outFile = measurementFile("race");
const params = await prepare();

const schedule = [];
for (let round = 0; round < perDelay; round++) schedule.push(...DELAYS_MS);
console.log(`Demo account ${account.address}. ${schedule.length} trials, delays ${DELAYS_MS.join(", ")} ms. Writing ${outFile.pathname}`);

let failures = 0;
for (const [index, delayMs] of schedule.entries()) {
  const trial = index + 1;
  try {
    await reactorReady();
    await clearQueue(params);
    const { requestId } = await queueOne(params, AMOUNT);

    // The borrower repays everything it owes: that cash is what the queue and the competitor race for.
    // The competitor's borrow is sent right behind the repayment with the next nonce, so with no delay it can
    // land in the very next block, as fast as a bot on the same chain. Waiting for our own receipt first would
    // add a second or more and flatter the queue.
    const owed = await debtOwed();
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    const repayGas = await pub.estimateContractGas({ address: A.morpho, abi, functionName: "repay", args: [params, owed, 0n, account.address, "0x"], account });
    // Both transactions are prepared and signed before anything is sent, so broadcasting is the only thing
    // between them. Preparing through the public RPC takes about a second, which would otherwise make even a
    // zero-delay competitor land 1.4 s late (seen in the first attempt at this run).
    const sign = async (functionName, args, gas, txNonce) =>
      wallet.signTransaction(
        await wallet.prepareTransactionRequest({
          account,
          to: A.morpho,
          data: encodeFunctionData({ abi, functionName, args }),
          gas,
          nonce: txNonce,
        }),
      );
    const signedRepay = await sign("repay", [params, owed, 0n, account.address, "0x"], (repayGas * 3n) / 2n + 60_000n, nonce);
    const signedBorrow = await sign("borrow", [params, owed, 0n, account.address, account.address], COMPETITOR_GAS, nonce + 1);
    const repayHash = await pub.sendRawTransaction({ serializedTransaction: signedRepay });
    await sleep(delayMs);
    const hash = await pub.sendRawTransaction({ serializedTransaction: signedBorrow });
    const repayReceipt = await pub.waitForTransactionReceipt({ hash: repayHash, timeout: 60_000 });
    if (repayReceipt.status !== "success") throw new Error(`repay reverted: ${repayHash}`);
    const repaid = { hash: repayHash, block: Number(repayReceipt.blockNumber) };
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    const competitorWon = receipt.status === "success";

    // If the competitor lost, the queue must have been paid; give the callback time to be read back.
    let settledBlock = 0;
    for (let waited = 0; waited < 20_000; waited += 1000) {
      const [request] = await read(A.vault, "requestsSlice", [BigInt(requestId), 1n]);
      settledBlock = Number(request.settledBlock);
      if (settledBlock || competitorWon) break;
      await sleep(1000);
    }

    const repayBlock = repaid.block;
    const competitorBlock = Number(receipt.blockNumber);
    const [repayMs, competitorMs] = await Promise.all([blockMs(repayBlock), blockMs(competitorBlock)]);
    const row = {
      trial,
      delayMs,
      requestId,
      repayTx: repaid.hash,
      competitorTx: hash,
      repayBlock,
      competitorBlock,
      lagMs: competitorMs - repayMs,
      payoutBlock: settledBlock || null,
      payoutLagMs: settledBlock ? (await blockMs(settledBlock)) - repayMs : null,
      winner: competitorWon ? "competitor" : settledBlock ? "queue" : "unclear",
      at: new Date().toISOString(),
    };
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    console.log(`trial ${trial}/${schedule.length}: delay ${delayMs} ms, competitor landed ${row.lagMs} ms after the repayment, winner ${row.winner}`);
  } catch (cause) {
    failures++;
    appendFileSync(outFile, JSON.stringify({ failed: true, trial, delayMs, error: String(cause?.shortMessage ?? cause?.message ?? cause), at: new Date().toISOString() }) + "\n");
    console.log(`trial ${trial}: FAILED ${cause?.shortMessage ?? cause?.message ?? cause}`);
    if (failures >= 6) {
      console.log("Six failures. Stopping so the cause can be looked at.");
      break;
    }
    await sleep(5000);
  }
}
console.log("DONE");
