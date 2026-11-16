# Threat model: Spillway

Reviewed 2026-11-16, for deployment v3 (hardening of v2). Reviewer: agent. Shown to Right: 2026-11-16; all findings fixed.

Method: AGENTS.md Section 5, "Abuse review before any deployment". Every entry point of v2 was listed and asked who can trigger it, at what cost to them and to us, and what they gain. Findings are ranked by what they would do to the live demo during judging, then in production.

## 1. Actors
| Actor | What they control | What they want |
|---|---|---|
| Lender | their wallet, vault shares | their money back, quickly and in order |
| Pool provider | their wallet, pool shares | fee income without losing principal |
| Stranger | any wallet, free testnet USDC and ETH from faucets | to profit, or to break the demo cheaply |
| Same-chain bot | next-block inclusion on Base Sepolia | to take cash a borrower repays before the queue does |
| Deployer (Right) | wiring, gas funds, the demo market's collateral | the product working and the demo staying live |
| Demo account (server) | a throwaway testnet key on Vercel | to run loops for judges without a wallet |
| Reactive Network | system contract, callback proxy, signer | delivering events and callbacks; charges lREACT and ETH |
| Judge | the live site, no wallet | to check claims quickly |

## 2. Entry points (v2)
| Entry point | Who can trigger it | Cost to them | Cost to us | What they could gain or break |
|---|---|---|---|---|
| `QueueVault.deposit` / `mint` | anyone | the deposit | none | nothing beyond shares |
| `QueueVault.requestRedeem` | share holders | gas | none | a large request at the front blocks smaller ones behind it (F4) |
| `QueueVault.settle` | anyone | gas | none | pays only owed people, in order (safe) |
| `QueueVault.transferClaim` / `approveClaim` | owner or approved | gas | none | safe (owner check, single-use approval, not after settled) |
| `QueueVault.claimUnpaid` | anyone owed | gas | none | safe |
| `InstantPool.deposit` / `withdraw` | anyone | the deposit | none | fee captured by a provider who joins just before a sale (F6) |
| `InstantPool.cashOut` / `buyClaim` | share or place holders | the fee | none | a place at the back of a long line sells as cheaply as one at the front (F3) |
| `QueueReactor.react` | Reactive system only | n/a | lREACT per event | any event matching a subscription costs us (F2) |
| `QueueReactor.setCallbackContract`, `withdrawGasFunds` | deployer only | n/a | none | safe |
| `SpillwayCallback.settle` | callback proxy acting for our reactor only | n/a | ETH per callback | safe (sender checks) |
| Morpho market: `supply` | anyone | gas plus the supply (1 wei is enough) | one reaction, plus a callback if someone waits | F2 |
| Morpho market: `borrow` | anyone holding collateral | gas | testnet USDC in the vault | F1 |
| Morpho market: `repay` on behalf of any borrower | anyone | gas plus the repayment (1 wei is enough) | one reaction, plus a callback if someone waits | F2 |
| `DemoCollateral.mint` | anyone | gas | none directly | enables F1 |
| `/api/demo` | anyone on the internet | nothing | demo account gas, reactor lREACT | bounded at 80 actions a day per server instance and 5 a minute per IP (F8) |
| `/api/history`, `/api/claim` | anyone | nothing | RPC calls | rate limited, read only (safe) |
| Funded: reactor (lREACT), callback (ETH), demo account (USDC, ETH), pool (USDC) | see above | | | F2, F8 |

## 3. Findings and how v3 closes them

Every finding is fixed; none is accepted. Each fix has a test that performs the attack and shows it fails. Suite: 77 tests pass with the Base Sepolia fork, 69 without it (the fork tests skip). Line coverage: QueueVault 97 percent, QueueReactor 94, InstantPool 94, SpillwayCallback 91, RestrictedCollateral 87.

| # | Finding in v2 | Fix in v3 | Attack tests |
|---|---|---|---|
| F1 | Anyone could mint the demo collateral and, with the fixed-price oracle, borrow every dollar in the market and never repay. A bot doing that after each repayment could block the queue indefinitely. | `RestrictedCollateral`: only approved accounts (the deployer and the demo account) can mint it or hold it; Morpho is approved so it can hold the collateral it secures. A stranger cannot mint it, cannot be sent it, and so cannot borrow. | `test_fork_strangerCannotBorrowFromTheMarket` (real Morpho Blue: mint refused, transfer refused, borrow refused with "insufficient collateral") |
| F2 | Anyone could make the reactor spend lREACT with a 1 wei supply or repayment, or by cycling small deposits and withdrawal requests, and drain it. | The reactor subscribes only to `Repay` where an approved borrower is both caller and borrower (topics 2 and 3), `Liquidate` of an approved borrower, and its own callback's `LoopClosed`. It no longer watches Morpho `Supply` or any vault event; deposits pay the queue inside the vault. It also checks the same conditions itself, keeps one callback in flight, and can be paused. | `test_strangerRepayingOnOurBorrowersBehalfTriggersNothing`, `test_strangerSupplyTriggersNothing`, `test_unapprovedBorrowerTriggersNothing`, `test_strangerCyclingDepositsAndRequestsTriggersNothing`, `test_noSubscriptionAnyStrangerCanTrigger`, `test_subscribesOnlyToApprovedBorrowersAndTheCallback`, `test_fork_reactorFiltersMatchRealMorphoLogs` (real Morpho: a stranger's 1 wei repayment carries the stranger as caller and does not match), `test_oneCallbackInFlightAtATime`, `test_pauseDropsEverySubscriptionAndIgnoresEvents`, `test_onlyTheDeployerCanPauseOrChangeBorrowers` |
| F3 | The pool's fee ignored how much was queued ahead of a place. | Fee = drain part (up to 3 percent) plus wait part `2% x queued / (queued + pool)`, capped at 5 percent. A place already held is priced on what it is still owed, with the rest of the line counted as ahead. | `testFuzz_feeRisesWithTheLineAhead`, `test_feeForANewPlaceCountsEveryoneQueued`, `test_buyClaimPricesWhatIsStillOwed`, `testFuzz_feeStaysWithinBounds` |
| F4 | One large request at the front blocked everyone behind it until fully repaid. | The front request is paid in parts as cash returns (parts under 1 USDC wait); nobody behind it is paid until it is complete. | `test_partialPaymentOfTheFront`, `test_partBelowTheMinimumWaits`, `test_aLargeRequestAtTheFrontIsPaidDownNotStuck`, `testFuzz_partialRepaymentPaysStrictlyInOrder`, invariant: only the front request may be part paid |
| F5 | The reactor's count of waiting requests could drift and stall the queue. | Removed: the reactor keeps no count. A repayment that arrives while a callback is in flight is remembered and paid when that callback reports back; a callback that never reports back is given up after 60 seconds. | `test_aRepaymentDuringAFlightIsPaidWhenTheFlightReportsBack`, `test_aLostCallbackIsGivenUpAfterTheTimeout`, `test_loopClosedWithMoreAsksAgain` |
| F6 | A pool provider could join just before a sale and leave just after, taking fees they did not wait for. | New pool shares are locked for one hour; the lock moves with shares that are transferred. | `test_depositLockStopsAJustInTimeProvider`, `test_theLockTravelsWithTransferredShares` |
| F7 | The pool's providers lose if the market's loans go bad. | With F1 fixed, only approved borrowers can borrow, against collateral worth far more than the loan at the market's fixed price, so bad debt cannot arise in this deployment. | covered by F1's test |
| F8 | The demo endpoint's daily cap lived in each server instance's memory. | The cap is counted from the chain: the server counts the demo account's requests made today from `QueueVault` storage before acting, so every instance sees the same number. Implemented in the web app with the v3 switch-over. | to be added with the web change: `/api/demo` refuses once today's on-chain count reaches the cap |
| F9 | Reentrancy, rounding, replay, access control. | No finding. `nonReentrant` on every state change, sender checks on callbacks, decimals offset against share inflation, `minReceive` on sales. | existing tests |

## 4. Facts that are not loopholes
- Testnet only, and not audited by a third party.

## 5. What v3 costs
- One full redeploy: about 2.5 lREACT plus Base Sepolia gas.
- The 204-loop and 40-trial measurements stay as evidence from v2; v3 gets a short fresh run to show it behaves the same.

## 6. Decisions by Right
- 2026-11-16: fix all findings; accept none ("we close it up").
