# Security review and limits

Reviewed 2026-11-16 by reading every external function of the four contracts and the three API routes, and against the test suite. Not an audit by a third party. Testnet only; do not send real funds.

## What was checked and holds

| Area | Result | Evidence |
|---|---|---|
| Who can call what | Every function that moves money or changes wiring is guarded. `QueueReactor.react` only from Reactive's system contract; `SpillwayCallback.settle` only from the Base Sepolia callback proxy acting for our reactor; wiring and gas withdrawals only by the deployer. | `test_onlyTheSystemContractCanCallReact`, `test_callbackRejectsAnyoneButTheProxyAndTheReactor`, `test_callbackWiringIsSetOnceByTheDeployer`, `test_gasFundsGoBackOnlyToTheDeployer` |
| `QueueVault.settle` open to anyone | Safe by design: it can only pay people already in the queue, in order. | `test_anyoneCanSettleAndOnlyOwnersArePaid` |
| Queue order | Strict first in, first out; nobody skips ahead, even when they would fit. | `test_nobodyJumpsTheLine`, `testFuzz_partialRepaymentPaysOnlyAPrefix` |
| Accounting | What the vault owes always equals the queue, every dollar is accounted for, the queue is always backed by the Morpho position. | six invariants in `contracts/test/Invariants.t.sol`, 64 runs of 80 random calls |
| A payout that fails | A blocked receiver cannot stall the queue; the money is held for them to collect. | `test_blockedReceiverDoesNotStallTheQueue` |
| Reentrancy | Every state-changing vault and pool function is `nonReentrant`; USDC has no transfer hooks. | `contracts/src/QueueVault.sol`, `contracts/src/InstantPool.sol` |
| Share price inflation | Both ERC-4626 contracts use a decimals offset of 6, matching Morpho's virtual shares. | `_decimalsOffset` in both contracts |
| Seller protection | `cashOut` and `buyClaim` revert if the seller would get less than `minReceive`; the app sets it 0.5 percent under the quote. | `test_minReceiveProtectsTheSeller` |
| Web secrets | The demo key is a server-only environment variable; checked absent from all public pages, scripts and API responses on the live site. | 2026-11-16 scan of 18 files |
| Web dependencies | `pnpm audit --prod`: no known vulnerabilities. | 2026-11-16 |
| Web API | Input validated and size capped; rate limited (history 30 per 10 s, demo 5 per minute per IP); demo amounts 1 to 5 USDC; 80 demo actions a day. Security headers: CSP, HSTS, no framing. | `web/src/app/api/*`, `web/next.config.ts` |

## Known limits

**Design**
- **A bot on the same chain that acts within about a second beats the queue** to cash a borrower repays. Measured in `measurements/README.md`.
- **Strict first in, first out.** One request too large for the cash that came back blocks smaller ones behind it until enough is repaid. That is the fairness promise, and the reason the pool exists.
- **A queued request is fixed in USDC** when made and earns nothing while it waits.
- **The pool's fee depends only on how drained the pool is, not on how long a place will wait.** A place at the back of a long queue costs the seller the same as one at the front. Pricing by expected wait is the obvious next step.
- **The pool values queue places at full value,** so its providers carry the risk that a place is never paid (for example, bad debt in the Morpho market).

**This deployment**
- **The demo market is ours and permissive.** Its collateral token (sdCOL) can be minted by anyone and its oracle price is fixed, so anyone can borrow all of the market's cash and never repay. That would take the testnet USDC sitting in the vault, not the loop itself: every demo loop brings its own cash. A production vault would lend on a curated market with a real oracle.
- **Anyone can make the reactor spend gas.** Reactive subscriptions match exact values only, so any supply or repayment on our market, however small, triggers a reactive transaction paid from the reactor's lREACT (about 0.015 to 0.03 each). Someone could drain it on purpose; the reactor would then stop until topped up. The demo endpoint is capped so visitors alone cannot.
- **Rate limits live in each server instance's memory.** Enough for a testnet demo, not for production.
- **Liquidations were not exercised live.** The reactor subscribes to `Liquidate`, and the topic is tested, but no live liquidation has happened on our market.
- **No third-party audit.**
