# Measurements

## Loop latency, 2026-11-16

**Question:** how long after a borrower repays does a queued withdrawal get paid, with nothing but Reactive Network watching?

**Result, all 204 loops recorded on chain:** median 1.6 s, p90 2.4 s, p95 2.8 s, p99 4.0 s, fastest 1.0 s, slowest 6.6 s, mean 1.72 s. 173 of 204 loops (85 percent) paid within 2.0 s.

| Percentile | Repayment to payout |
|---|---|
| p50 | 1,600 ms |
| p90 | 2,400 ms |
| p95 | 2,800 ms |
| p99 | 4,000 ms |
| min / max | 1,000 ms / 6,600 ms |

Blocks between repayment and payout on Base Sepolia (200 ms each): 5 to 11 blocks for 197 of 200 runner loops; the tail ran to 33 blocks.

### How it was measured
- **Loop:** the demo account deposits 1 to 3 USDC, the demo borrower borrows everything the market can release, the deposit is queued for withdrawal, and the borrower repays. Nothing else is sent. `QueueReactor` on Reactive Lasna sees Morpho Blue's `Repay`, asks for a callback, and `SpillwayCallback` on Base Sepolia pays the queue.
- **Timing comes from the chain, not from our script.** Start: the millisecond timestamp of the Base Sepolia block holding the repayment (`timestampMs` from the RPC). End: the millisecond time `SpillwayCallback` stored when it paid (`BaseTime.timestampMs()` at `0x4200000000000000000000000000000000000030`). Base Sepolia makes a block every 200 ms, so times fall in 200 ms steps.
- **Two independent records agree.** The runner's log (`loops-2026-11-16.jsonl`) and a recomputation from contract storage alone (`latency-2026-11-16.json`, from `SpillwayCallback.loopsSlice`) match on all 200 runner loops: same origin blocks, same latencies.
- **The 204 on-chain loops are** the runner's 200, one started from the web app's demo console, and three from clearing a stuck queue (one of those was a second callback for the same repayment, because one callback pays at most 4 requests and the reactor asked again).

### What failed, and why
13 runner attempts failed out of 213. None was a missed or late payout by Reactive.
- **10 attempts, first run:** a stale gas estimate from the load-balanced public RPC made one `requestRedeem` run out of gas after its deposit and borrow had landed. The next attempt queued those leftover shares together with its own and repaid only its own amount, so a 5.7 USDC request sat at the front of a strict first-in, first-out queue with too little cash behind it, and nobody behind it could be paid. Reactive called back 7 to 9 blocks after every repayment in that period; the vault correctly paid no one. The runner was fixed (gas headroom, repay the full debt, clear any stuck queue first) and the backlog was then paid by Reactive in two rounds.
- **3 attempts, second run:** `requestRedeem` refused with `RequestTooSmall` at the estimate step, before anything was sent. The shares read back came from a node that had not yet seen that loop's deposit, and the vault refuses withdrawals under 1 USDC. No state changed and the next attempt ran normally.

### Limits of this measurement
- One market, one demo account, our own transactions. This is not user traffic.
- Base Sepolia and Reactive Lasna are testnets; mainnet timing may differ.
- The clock on Base Sepolia runs in 200 ms steps, so differences under 200 ms are not visible.
- The run took place 08:01 to 13:22 UTC on 2026-11-16, with gaps while a stuck queue was diagnosed.

### Reproduce
From `web/`, with the demo account's key in `web/.env.local`:

```
node scripts/run-loops.mjs 200      # runs loops, writes loops-<date>.jsonl
node scripts/latency-report.mjs     # recomputes every loop from the chain, writes latency-<date>.json
```
