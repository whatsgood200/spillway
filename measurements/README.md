# Measurements

## Current contracts (v3), 2026-11-16

20 loops on the hardened contracts, run with `scripts/run-loops.mjs` after the v3 deployment: median 1.4 s, p90 2.0 s, fastest 1.0 s, slowest 2.0 s, mean 1.44 s, none failed. The runner's log (`loops-v3-2026-11-16.jsonl`) and `SpillwayCallback` storage on v3 agree: 20 loops on chain. Each loop cost the reactor about 0.026 lREACT, against about 0.06 on v2, because the v3 reactor no longer reacts to vault events.

The longer runs below were made on the earlier contracts (v2, retired). v3 changes who can trigger the loop, not how the loop works, and its 20-loop check falls inside the v2 distribution.

## Loop latency on v2, 2026-11-16

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

## Race experiment on v2, 2026-11-16

**Question:** when a borrower repays into a fully lent vault, who gets that cash: the withdrawal queue, paid through Reactive Network, or a competing borrower trying to take the same cash?

**Result, 40 trials:** a competitor that landed within 1.4 s of the repayment won every time (16 of 16). Between 1.6 and 2.6 s the queue won 12 of 14. From 3.2 s on the queue won every time (10 of 10).

| Competitor landed after the repayment | Trials | Queue got the cash |
|---|---|---|
| 0.2 to 1.4 s | 16 | 0 |
| 1.6 to 2.6 s | 14 | 12 |
| 3.2 to 6.6 s | 10 | 10 |

By the delay the competitor waited (from `src/data/race.json`, made by `scripts/race-report.mjs`):

| Competitor waited | Landed after the repayment (median, range) | Queue won |
|---|---|---|
| 0 ms | 400 ms (200 to 400) | 0 of 5 |
| 400 ms | 800 ms (600 to 1,000) | 0 of 5 |
| 800 ms | 1,000 ms (1,000 to 1,400) | 0 of 5 |
| 1,200 ms | 1,600 ms (1,400 to 1,600) | 4 of 5 |
| 1,600 ms | 2,200 ms (1,800 to 2,600) | 4 of 5 |
| 2,000 ms | 2,400 ms (2,200 to 2,600) | 4 of 5 |
| 3,000 ms | 3,400 ms (3,200 to 3,400) | 5 of 5 |
| 5,000 ms | 5,800 ms (5,400 to 6,600) | 5 of 5 |

The two queue losses in the middle band (competitor at 1.8 s and 2.4 s) were trials where the loop itself was slower than the competitor. In every queue win the payout landed 1.0 to 2.6 s after the repayment.

### What this shows
- **Where Omni's speed changes the outcome.** Anyone slower than about 1.5 to 2 s, such as a person, a keeper polling on a schedule, or a bot that waits a few blocks to be safe, loses the cash to the queue. On the previous Reactive Network, blocks were about 7 s apart, so the loop alone would have taken longer than that, and the queue would have lost to anyone acting within several seconds. That legacy figure is an estimate from block times, not something we measured.

### How it was measured
- Each trial: clear the queue, deposit 1.5 USDC, borrow everything, queue the withdrawal (`scripts/lib/live.mjs`).
- The repayment and the competitor's borrow of the same amount are prepared and signed before either is sent, then broadcast with the chosen gap (`scripts/race.mjs`). Without pre-signing, the competitor could not land sooner than 1.4 s, which would flatter the queue.
- The winner is read from the chain: the competitor's receipt status (its borrow reverts with "insufficient liquidity" if the queue already took the cash) and the request's `settledBlock` in `QueueVault` storage. Lag is measured from the two blocks' millisecond timestamps.
- The competitor is our own demo account. Delays were interleaved across the run, not run in blocks.
- Two earlier attempts are kept but not counted, because both let the competitor start late and so favoured the queue: `race-2026-11-16-pilot.jsonl` (competitor waited for our own receipt) and `race-2026-11-16-unsigned.jsonl` (competitor prepared its transaction after the repayment was sent).

### Reproduce
```
node scripts/race.mjs 5                    # 5 trials per delay, writes race-<date>.jsonl
node scripts/race-report.mjs 2026-11-16    # summary, and the file the latency page reads
```

## Real data: Base mainnet

What happens today, without a queue, when a borrower repays into a fully lent-out market. File: [`morpho-base-2026-11-16.json`](morpho-base-2026-11-16.json). Script: [`web/scripts/morpho-crunch.mjs`](../web/scripts/morpho-crunch.mjs).

```bash
cd web && END_TIME=1794860728 node scripts/morpho-crunch.mjs
```

**Data.** Every Supply, Withdraw, Borrow, Repay and Liquidation from 2025-11-16 to 2026-11-16 in the 11 listed Morpho Blue markets on Base (over 1M USD supplied) whose hourly utilization reached 99.5 percent for at least 5 hours: 470,335 transactions from the public Morpho API (`blue-api.morpho.org`). Each time window is fetched in one page and checked against the API's own count.

**Rebuild.** Liquidity (supply minus borrow) changes only through those five actions; interest and bad debt move supply and borrow equally. Liquidity after every transaction is rebuilt backwards from the market's current liquidity. Checked against Morpho's hourly liquidity figures: the 95th percentile error is 0.000 percent of supply in all 11 markets. Two sample events were also checked by decoding their Morpho logs from a Base RPC.

**Timing.** Base mainnet made a block every 2 s until block 53,556,127 (timestamp 1793901601) and every 200 ms after it, so block times are exact.

**Definitions.** A repayment is into a dry market when liquidity just before it is at most 0.5 percent of total supply (repayments under 0.01 percent of supply are ignored). The freed cash is taken when liquidity falls back to within 10 percent of the freed amount above where it was. Who took it is the sum of Withdraw (split into Morpho vaults and direct lenders) and Borrow amounts until then.

| Result | Value |
|---|---|
| Repayments into a dry market | 135 |
| Freed cash taken by another transaction | 110 |
| Not taken within 24 hours | 25 |
| Taken within 2 s / 10 s / 60 s / 1 h | 0 / 7 / 19 / 45 of 110 |
| Time until taken, median (p25 to p75) | 1.6 h (15 min to 3.3 h) |
| Fastest | 4 s, a vault reallocation in the WETH/weETH market |
| Who took it | lenders withdrawing directly 69 %, borrowers 27 %, vaults 4 % |

**What it shows.** Freed cash is not grabbed in milliseconds today; it waits until someone notices, and then goes to whoever acts first, mostly lenders withdrawing on their own. A queue that settles on the repayment itself pays the lenders already waiting, in order, before any taker seen here.

**What it does not show.** Whether the lenders who withdrew had been waiting, and how fast takers will become now that Base makes a block every 200 ms (the change is under a month old). Ethereum markets are not included.
