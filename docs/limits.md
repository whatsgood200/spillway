# Security review

Current contracts (v3), reviewed 2026-11-16. The full abuse review, with every actor, every entry point and the attack test for each finding, is in [threat-model.md](threat-model.md). Scope: Base Sepolia and Reactive Lasna testnets, test funds only, not audited by a third party.

## What was checked and holds

| Area | Result | Evidence |
|---|---|---|
| Who can call what | Every function that moves money or changes wiring is guarded. `QueueReactor.react` only from Reactive's system contract; `SpillwayCallback.settle` only from the Base Sepolia callback proxy acting for our reactor; pausing, borrower changes, wiring and gas withdrawals only by the deployer. | `test_onlyTheSystemContractCanCallReact`, `test_callbackRejectsAnyoneButTheProxyAndTheReactor`, `test_onlyTheDeployerCanPauseOrChangeBorrowers`, `test_callbackWiringIsSetOnceByTheDeployer`, `test_gasFundsGoBackOnlyToTheDeployer` |
| Nobody else can make us pay gas | The reactor reacts only to an approved borrower repaying its own loan or being liquidated. A stranger's supply, deposit, withdrawal request or 1 wei repayment reaches nothing. | `test_strangerRepayingOnOurBorrowersBehalfTriggersNothing`, `test_strangerSupplyTriggersNothing`, `test_strangerCyclingDepositsAndRequestsTriggersNothing`, `test_fork_reactorFiltersMatchRealMorphoLogs` |
| Nobody else can borrow the market's cash | Only approved accounts can mint or hold the collateral; on the real Morpho Blue a stranger's mint, transfer and borrow are refused. | `test_fork_strangerCannotBorrowFromTheMarket` |
| `QueueVault.settle` open to anyone | Safe by design: it can only pay people already in the queue, in order. | `test_anyoneCanSettleAndOnlyOwnersArePaid` |
| Queue order | Strictly first in, first out; the front request may be paid in parts and nobody behind it is paid until it is complete. | `testFuzz_partialRepaymentPaysStrictlyInOrder`, `test_aLargeRequestAtTheFrontIsPaidDownNotStuck`, invariant in `contracts/test/Invariants.t.sol` |
| Accounting | What the vault owes always equals what is still owed to the queue; every dollar is accounted for; the queue is always backed by the Morpho position. | six invariants, 64 runs of 80 random calls |
| Pool pricing | Fee grows with pool drain and with the line ahead, never above 5 percent; a held place is priced on what it is still owed. | `testFuzz_feeRisesWithTheLineAhead`, `testFuzz_feeStaysWithinBounds`, `test_buyClaimPricesWhatIsStillOwed` |
| Pool fairness | New deposits are locked for an hour, and the lock follows transferred shares, so nobody can join just before a sale and leave just after. | `test_depositLockStopsAJustInTimeProvider`, `test_theLockTravelsWithTransferredShares` |
| A payout that fails | A blocked receiver cannot stall the queue; the money is held for them to collect. | `test_blockedReceiverDoesNotStallTheQueue` |
| Lost or overlapping callbacks | One callback in flight; a repayment that lands meanwhile is paid when it reports back; a lost callback is given up after 60 s. | `test_aRepaymentDuringAFlightIsPaidWhenTheFlightReportsBack`, `test_aLostCallbackIsGivenUpAfterTheTimeout` |
| Reentrancy, share inflation, seller protection | `nonReentrant` on every state change; decimals offset of 6 on both ERC-4626 contracts; `minReceive` on every sale. | contracts, `test_minReceiveProtectsTheSeller` |
| Web secrets | The demo key is a server-only environment variable; checked absent from every public page, script and API response on the live site. | scan of the live site, 2026-11-16 |
| Web dependencies | `pnpm audit --prod`: no known vulnerabilities. | 2026-11-16 |
| Web API | Input validated and size capped; rate limited per IP; demo amounts 1 to 5 USDC; daily demo caps counted from contract storage, so they hold across every server instance; a demo repayment is refused when nobody is waiting. Security headers: CSP, HSTS, no framing. | `web/src/app/api/*`, `web/src/lib/server/demo.ts`, `web/next.config.ts` |
