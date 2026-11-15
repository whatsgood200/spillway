# Plan: Spillway (working name)

Track: Every Second Counts. Written 2026-11-15. Right chose to keep the idea and lead with the pool on 2026-11-15, after the originality check found two entrants building a queue alone; treated as approval of this plan.

## One line
Spillway lets a lender stuck in a vault withdrawal queue sell their place for cash now, and repays the buyer the second liquidity returns.

Positioning: the pool is the product; the self-settling queue is the mechanism underneath. Two other entrants (`sainath998/instant-queue`, `emilhuseyn/reactive-omni`) built the queue alone on mock vaults, so every public description leads with the pool, the real Morpho Blue market, and the measured race.

## Five question test
1. **Who has it.** Lenders in curated lending vaults (Morpho style) when utilization hits 100 percent. Their funds are lent out, so withdrawals wait.
2. **How painful.** On 4 Nov 2025 withdrawable liquidity in two Gauntlet Morpho vaults stayed below 1 percent for about six hours (Gauntlet's report, see research notes). Whatever liquidity came back was taken by whoever had the fastest bot, not by who had waited longest.
3. **How they cope today.** Refresh and retry, run a private bot, or sell the vault token at a discount on a DEX if one exists. Async vaults (ERC-7540) queue requests but rely on an operator bot to settle them.
4. **Our angle.** The queue settles itself: a reactive contract hears the repayment on the lending market and pays the queue head in the next second, in order, with no operator. A pool buys queue places for an explicit fee, so a lender can leave now. This is the instant unstake design Sanctum runs on Solana, moved to lending withdrawals, with the claim and repay half automated.
5. **Can we build a convincing version.** Yes. Morpho Blue is deployed on Base Sepolia (code confirmed at `0xBBBB...FFCb` on 2026-11-15) and is permissionless, so the market is real protocol code. Testnet activity will be ours and labelled as ours.

## User, done statement, hero moment
- **User:** a lender with 1,000 to 100,000 USDC in a vault, on a laptop or phone, during a liquidity crunch, who wants out.
- **Done statement:** a user can request a withdrawal from a fully utilized vault and either (a) be paid automatically, in queue order, within about two seconds of a repayment landing, or (b) take cash immediately from the pool for a fee shown before they sign.
- **Hero moment:** the status page shows "Paid 1,000.00 USDC, 1.3 s after a repayment landed", with three links: the repayment on Base Sepolia, the reactive transaction on Lasna, the payout callback on Base Sepolia.
- **System behind it:** `Repay`, `Supply` or `Liquidate` on Morpho Blue (origin event) -> reactive contract on Lasna checks its own record of the queue -> callback to the vault on Base Sepolia -> vault withdraws what Morpho can release and pays the queue head.

## Why this needs Omni (the Integration answer)
Freed liquidity is contested. A borrower or a bot can take it in the next blocks. At 7 s the queue loses that race; at about 1 s it can win it. We will measure this directly: a competing borrower fires N seconds after each repayment, and we report the share of freed liquidity that reached the queue at each N. Remove the reactive contract and the queue never settles without an operator.

## Contracts
Base Sepolia (84532):
- `QueueVault`: USDC vault that supplies to one Morpho Blue market. Deposit, request redeem, FIFO queue, `settle(maxItems)` open to anyone and called by the callback. Emits `RedeemQueued`, `RedeemSettled` (with `BaseTime.timestampMs()`), `ClaimTransferred`.
- `InstantPool`: LP funded USDC pool. `sellClaim(requestId)` pays the user now, takes over the queue place, and is repaid by the vault on settlement. Fee rises as the pool drains (Sanctum curve, 8 to 800 bps as the starting parameters).
- `SpillwayCallback` (inherits `AbstractCallback`): validates callback proxy and reactive sender, forwards to `settle`.
- Demo support, labelled as ours: collateral token, price oracle we control, borrower script.

Reactive Lasna (5318007):
- `QueueReactor` (inherits `AbstractReactive`): subscribes to the Morpho Blue market's liquidity events and the vault's queue events, keeps queue depth in its own storage, and requests a callback only when the queue is non-empty and liquidity arrived. Exposes `coverDebt()`.

Should have: a reserve on Unichain Sepolia (1301) that refills the pool when `ClaimSold` drains it below a threshold. The trigger is reactive; the transfer uses Circle CCTP V2, which needs an attestation relayer, so it is a slower secondary leg (about 10 to 20 s, to be measured) and will be stated as such.

## MoSCoW
- **Must:** vault with FIFO queue on a real Morpho Blue market; reactive settlement loop; instant pool with fee curve; latency recorded on chain in milliseconds; at least 200 measured loops with p50, p90, p99; race experiment at several delays; web app with the full flow; judge access without a wallet; Foundry unit, fuzz and invariant tests plus a fork test against Morpho Blue; README, JUDGES.md, video under 3 minutes.
- **Should:** Unichain reserve refill; funding runway monitor that warns before the reactor or callback runs dry; partial fills; public latency page that updates live.
- **Could:** auto top up of reactor funds; ERC-7540 interface conformance; a second market.
- **Won't:** mainnet deployment; real yield strategy; governance; token.

## Main journey (screens)
1. Vault overview: liquidity, utilization, queue depth, last settlement latency.
2. Deposit USDC.
3. Withdraw: paid at once if liquidity exists; otherwise two choices with numbers, "Wait in queue (position 3)" or "Get 992.40 USDC now (fee 7.60 USDC)".
4. Claim status: timeline of queued, liquidity arrived, reactive transaction, paid, each with a link and a millisecond timestamp.
5. Pool: provide liquidity, see fee income, claims held, pending repayments.
6. Latency: histogram and percentiles of every loop, method, raw transaction list, race experiment result.
7. Demo console: "Send a repayment" from a funded demo borrower, so a judge can cause the hero moment in one click.

## Measurement method
Origin time is the origin block's millisecond timestamp (Base Sepolia `blockTimestampMs`). Callback time is `BaseTime.timestampMs()` written into `RedeemSettled`. Latency is the difference, on chain, at 200 ms resolution. No other entry uses millisecond timestamps; the largest sample in the field is 21 loops. We also record the Lasna transaction for each loop.

## Riskiest unknowns and fallbacks
| Unknown | Spike (1 to 2 hours each) | Fallback |
|---|---|---|
| Reactive delivers Base Sepolia events and callbacks in about 1 to 2 s | Emit an event, measure 20 loops | None needed if others' 1.3 to 1.6 s holds; otherwise the pitch becomes ordering and trustlessness |
| Subscribing to the Morpho Blue singleton filtered by market id in topic 1 | Deploy reactor, repay on our market, confirm `react()` fires | Subscribe on topic 0 only and filter by id inside `react()` |
| Creating a usable market on Base Sepolia (enabled IRM and LLTV, our oracle) | `createMarket`, supply, borrow to 100 percent, repay | Deploy our own Morpho Blue instance from the audited source, stated in the README |
| Callback gas and funding (any debt stops delivery silently) | Read proxy fee parameters, size gas limit, run to exhaustion once | Runway monitor and manual `depositTo` |
| Testnet USDC supply for 200 plus loops | Circle faucet | Recycle the same USDC in a loop; or a labelled test token |
| CCTP V2 fast transfer timing on these testnets | One transfer each way | Drop the Unichain leg from the demo and list it under limits |

## Schedule (deadline 5 Dec 20:00 UTC; submit 4 Dec)
- 15 Nov: plan (this gate).
- 16 to 17 Nov: spikes, deployed skeleton, design directions.
- 17 to 21 Nov: full UI on the mock adapter (gate by 21 Nov).
- 21 to 25 Nov: contracts and tests, testnet deploy, verify.
- 25 to 27 Nov: connect; hero path real on the deployed URL.
- 28 to 30 Nov: latency runs, race experiment, Unichain leg, security pass.
- 1 Dec: feature freeze.
- 2 to 3 Dec: README, judge pack, video.
- 4 Dec: submit. 5 Dec: buffer.

## Interview questions for Right to ask lenders
1. Have you ever been unable to withdraw from a lending vault? What did you do in the first hour?
2. If you could leave at once for a fee, what fee would you accept at 1,000 USDC and at 50,000 USDC?
3. Would you trust an automatic queue more than a retry button, and what would you need to see to believe it is in order?

## What Right must do
- Create a fresh deployer wallet and fund it: Base Sepolia ETH (some sent to the Reactive faucet contract for lREACT, never more than 5 ETH per transaction), Unichain Sepolia ETH, testnet USDC from faucet.circle.com.
- Keep the key in an encrypted Foundry keystore (`cast wallet import`), never in the repo or chat.
- Approve or change the name "Spillway".
