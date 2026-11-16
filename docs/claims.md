# Claims a judge can check

Every claim below points at the line that enforces it, a test that attacks it, or a transaction on chain. Line links are to `main`; the contracts have not changed since the v3 deployment on 2026-11-16. The live walkthrough is [JUDGES.md](../JUDGES.md).

```bash
cd contracts && ./install-deps.sh
BASE_SEPOLIA_RPC=https://sepolia.base.org forge test   # 77 tests, including fork tests against the deployed Morpho Blue
```

The same suite runs on every push in [GitHub Actions](https://github.com/whatsgood200/spillway/actions/workflows/ci.yml); Foundry 1.9 there reports the six invariants as one test, so it shows 72.

## The reactive loop

| Claim | Where | Test or proof |
|---|---|---|
| The reactor watches only an approved borrower repaying its own loan, or being liquidated, on our market | [`QueueReactor.sol:218-227`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L218-L227) (subscriptions), [`QueueReactor.sol:160-164`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L160-L164) (checked again in `react`) | `test_subscribesOnlyToApprovedBorrowersAndTheCallback`, `test_fork_reactorFiltersMatchRealMorphoLogs` |
| Nobody else can make it react, so nobody else can make us pay for gas | [`QueueReactor.sol:152`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L152) `onlySystem`, [`QueueReactor.sol:163`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L163) the borrower must repay for itself | `test_strangerRepayingOnOurBorrowersBehalfTriggersNothing`, `test_strangerSupplyTriggersNothing`, `test_strangerCyclingDepositsAndRequestsTriggersNothing` |
| One callback in flight; a repayment landing meanwhile is paid when the flight reports back; a lost callback is given up after 60 s | [`QueueReactor.sol:167-173`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L167-L173), [`QueueReactor.sol:178-190`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L178-L190) | `test_aRepaymentDuringAFlightIsPaidWhenTheFlightReportsBack`, `test_aLostCallbackIsGivenUpAfterTheTimeout` |
| The callback runs only when the Reactive callback proxy delivers it for our reactor | [`SpillwayCallback.sol:60-63`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/SpillwayCallback.sol#L60-L63) | `test_callbackRejectsAnyoneButTheProxyAndTheReactor`, `test_fork_callbackSettlesThroughTheRealProxyAddress` |
| Each loop is recorded on chain with a millisecond timestamp from the Base `BaseTime` predeploy | [`SpillwayCallback.sol:65-80`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/SpillwayCallback.sol#L65-L80), [`MsClock.sol:7-10`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/libraries/MsClock.sol#L7-L10) | `test_loopsAreRecordedOnChain`, `test_fork_millisecondClockIsLive` |
| Only the deployer can pause, change borrowers, wire the callback (once) or withdraw gas funds | [`QueueReactor.sol:57-59`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L57-L59), [`QueueReactor.sol:86-88`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L86-L88), [`QueueReactor.sol:113-133`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueReactor.sol#L113-L133) | `test_onlyTheDeployerCanPauseOrChangeBorrowers`, `test_callbackWiringIsSetOnceByTheDeployer`, `test_gasFundsGoBackOnlyToTheDeployer` |

## The queue

| Claim | Where | Test or proof |
|---|---|---|
| Withdrawals are strictly first in, first out; the front request may be paid in parts, and nobody behind it is paid until it is complete | [`QueueVault.sol:253-286`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueVault.sol#L253-L286) | `testFuzz_partialRepaymentPaysStrictlyInOrder`, `test_nobodyJumpsTheLine`, `invariant_queuedAssetsMatchesTheQueue` |
| One large request cannot hold the line still | [`QueueVault.sol:259-261`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueVault.sol#L259-L261) | `test_aLargeRequestAtTheFrontIsPaidDownNotStuck` |
| A new deposit pays the queue on its way in, without the reactor | [`QueueVault.sol:183-188`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueVault.sol#L183-L188) | `test_fullLoop_aDepositPaysTheQueueWithoutTheReactor` |
| `settle` is open to anyone and can only pay people already in the queue, in order | [`QueueVault.sol:247-251`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueVault.sol#L247-L251) | `test_anyoneCanSettleAndOnlyOwnersArePaid` |
| A blocked receiver cannot stall the queue; their money is held for them | [`QueueVault.sol:289-301`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueVault.sol#L289-L301) | `test_blockedReceiverDoesNotStallTheQueue` |
| No synchronous exits that would bypass the queue | [`QueueVault.sol:190-196`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueVault.sol#L190-L196) | `test_synchronousExitsAreDisabled` |
| Every dollar is accounted for and the queue is always backed by the Morpho position | [`Invariants.t.sol`](https://github.com/whatsgood200/spillway/blob/main/contracts/test/Invariants.t.sol#L143-L198) | six invariants, 64 runs of 80 random calls, no reverts |

## The pool

| Claim | Where | Test or proof |
|---|---|---|
| The fee has a drain part (0.08 to 3 percent) and a wait part (up to 2 percent), capped at 5 percent, and is shown before signing | [`InstantPool.sol:20-28`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/InstantPool.sol#L20-L28), [`InstantPool.sol:102-110`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/InstantPool.sol#L102-L110) | `testFuzz_feeStaysWithinBounds`, `testFuzz_feeRisesWithTheLineAhead`, `test_feeRisesAsThePoolDrains` |
| A seller never receives less than they agreed to | [`InstantPool.sol:166`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/InstantPool.sol#L166), [`InstantPool.sol:182`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/InstantPool.sol#L182) | `test_minReceiveProtectsTheSeller` |
| Only the holder of a place can sell it | [`InstantPool.sol:174`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/InstantPool.sol#L174) | `test_onlyTheOwnerCanSellAPlace` |
| New pool deposits are locked for an hour, and the lock follows transferred shares | [`InstantPool.sol:129-143`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/InstantPool.sol#L129-L143) | `test_depositLockStopsAJustInTimeProvider`, `test_theLockTravelsWithTransferredShares` |
| When the vault pays a place the pool bought, the pool gets the full amount | [`QueueVault.sol:253-286`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/QueueVault.sol#L253-L286) | `test_fullLoop_poolIsRepaidAutomatically`, `test_fork_poolBuysAPlaceAndIsRepaid` |

## The market

| Claim | Where | Test or proof |
|---|---|---|
| Only approved borrowers can borrow: only approved accounts can mint or hold the collateral | [`RestrictedCollateral.sol:30-38`](https://github.com/whatsgood200/spillway/blob/main/contracts/src/RestrictedCollateral.sol#L30-L38) | `test_fork_strangerCannotBorrowFromTheMarket` |
| The vault lends on the deployed Morpho Blue, not a mock | [deployments.md](../deployments.md) | `test_fork_queueSettlesOnRealMorpho` |

## Measured

| Claim | Source |
|---|---|
| Repayment to payout, v3: median 1.4 s, p90 2.0 s over 20 loops, none failed | [`loops-v3-2026-11-16.jsonl`](../measurements/loops-v3-2026-11-16.jsonl), method in [measurements/README.md](../measurements/README.md) |
| Repayment to payout, v2: median 1.6 s over 204 loops | [`loops-2026-11-16.jsonl`](../measurements/loops-2026-11-16.jsonl) |
| A competitor landing 1.6 to 2.6 s after a repayment lost the cash to the queue 12 of 14 times, and 10 of 10 from 3.2 s on | [`race-2026-11-16.jsonl`](../measurements/race-2026-11-16.jsonl) |
| How latency is computed: the start is the repayment block time in milliseconds (Base Sepolia blocks are 200 ms apart), the end is the time `SpillwayCallback` stored | [`history.ts:211-221`](https://github.com/whatsgood200/spillway/blob/main/web/src/lib/server/history.ts#L211-L221) |

## One lifecycle through the web app, with a wallet (2026-11-16)

Made from a fresh test wallet `0x45D366ae768AD13c9df0ddcd73176794E8F9dB88` using the app's own buttons.

| Step | Transactions |
|---|---|
| Deposit 3 USDC (approve, deposit) | [`0xaef4553a…`](https://sepolia.basescan.org/tx/0xaef4553a219f027bf54b778c08fe898bf76ed5eebba326a47497a52dce812c30), [`0x1cf1dcc0…`](https://sepolia.basescan.org/tx/0x1cf1dcc08baefd85c38e46de22efb0d94d23d1d692fc7b97266df27c40da7f5b) |
| Cash now: the pool bought request 22 and paid 0.9956 USDC at once | [`0x4ef5f13d…`](https://sepolia.basescan.org/tx/0x4ef5f13dfb1c916e34c44300b2f7c6fa1f9b4233c9719ab5632c08eb02d56e6a) |
| Join the queue (request 23), then sell that place for 0.9898 USDC | [`0xe14c1cec…`](https://sepolia.basescan.org/tx/0xe14c1cecd102c8b570a3502884b43d04db05cf4fbd8eb85847b323b88fd0afa4), [`0x44769ed8…`](https://sepolia.basescan.org/tx/0x44769ed80aa45ea917ed02eb627125d819da9d3b2d0ad10705fd35e2626ca742) |
| Repayment, reactive transaction on Lasna, payout of requests 22 and 23 to the pool (1.6 s) | [`0x614a1d84…`](https://sepolia.basescan.org/tx/0x614a1d840698a0cdf827c0d38c8a162df27ac7026a828942d1a8b01697e03a75), [`0xcc536c05…`](https://lasna.reactscan.net/tx/0xcc536c056ae102c0fa49f12a060ad663532aa5f7f92f5fc4d2b933a8f82d351a), [`0x5c9369d1…`](https://sepolia.basescan.org/tx/0x5c9369d19c19d0c685a148a26188a28f7ed6c9363db10677c0602e904dea283d) |
| Join the queue (request 24) and keep the place | [`0x322fc7e4…`](https://sepolia.basescan.org/tx/0x322fc7e4da5bd5ee8f280149fada71d1d73c8644bace227f22fee4b63ff01aca) |
| Repayment, reactive transaction on Lasna, payout to the wallet (0.8 s) | [`0x6e541c18…`](https://sepolia.basescan.org/tx/0x6e541c1830d1653e559db79d1e12e39965d4d351bc04baa534d13546d5a118f6), [`0x075fe325…`](https://lasna.reactscan.net/tx/0x075fe32568a4d154a5f71eafadef26f27264a476142d70d0c2e248c33dfc0cd9), [`0x96bd2120…`](https://sepolia.basescan.org/tx/0x96bd2120da4e9556efe44884e40ab96918cc46cfc7b29cd1d6085153fc319e35) |
| Pool deposit of 1 USDC; an early withdrawal is then refused (`maxWithdraw` is 0 for an hour) | [`0x410f7e98…`](https://sepolia.basescan.org/tx/0x410f7e98ea0fbcfc27a4a81cc503151f2a2765de4341e71c50080569e7336da2) |

## What refuses, and how to see it yourself

No key needed: each command calls a live contract as a stranger address and shows the revert.

| Bad action | Refused with | Command |
|---|---|---|
| Call the callback directly | `NotAuthorized(sender, proxy)` from the Reactive library | `cast call 0x6C78012f837B5A4602c9098D68e95F070018823D "settle(address,uint256,uint256,uint256)" 0x943d4252c759249D24D375E855B0a3caf13DB874 0 0 4 --from 0x000000000000000000000000000000000000dEaD --rpc-url https://sepolia.base.org` |
| Mint the market collateral to borrow its cash | `NotApproved(sender)` | `cast call 0x5Cab8749ec7F208e19211381FD185dC6e448D857 "mint(address,uint256)" 0x000000000000000000000000000000000000dEaD 1000000000000000000 --from 0x000000000000000000000000000000000000dEaD --rpc-url https://sepolia.base.org` |
| Withdraw past the queue | `SynchronousExitDisabled()` | `cast call 0x8a430D6472Fbf703233BA5083e134B490d2f60F6 "withdraw(uint256,address,address)" 1 0x000000000000000000000000000000000000dEaD 0x000000000000000000000000000000000000dEaD --rpc-url https://sepolia.base.org` |
| Feed the reactor a fake event on Lasna | `NotAuthorized(sender, system)` | `cast call 0x943d4252c759249D24D375E855B0a3caf13DB874 "react((uint256,address,uint256,uint256,uint256,uint256,bytes,uint256,uint256,uint256,uint256,uint256))" "(84532,0x000000000000000000000000000000000000dEaD,0,0,0,0,0x,0,0,0,0,0)" --from 0x000000000000000000000000000000000000dEaD --rpc-url https://lasna-rpc.rnk.dev/` |

## The web app

| Claim | Where |
|---|---|
| A production build cannot run on simulated data | [`index.ts:9-11`](https://github.com/whatsgood200/spillway/blob/main/web/src/lib/chain/index.ts#L9-L11) |
| The demo account's daily caps are counted from contract storage, so they hold across server instances; amounts are 1 to 5 USDC; a repayment with nobody waiting is refused | [`demo.ts:24-29`](https://github.com/whatsgood200/spillway/blob/main/web/src/lib/server/demo.ts#L24-L29), [`demo.ts:88`](https://github.com/whatsgood200/spillway/blob/main/web/src/lib/server/demo.ts#L88), [`demo.ts:186-187`](https://github.com/whatsgood200/spillway/blob/main/web/src/lib/server/demo.ts#L186-L187) |
| Every API route is rate limited per IP | [`route.ts:19`](https://github.com/whatsgood200/spillway/blob/main/web/src/app/api/demo/route.ts#L19), [`route.ts:7`](https://github.com/whatsgood200/spillway/blob/main/web/src/app/api/claim/route.ts#L7), [`route.ts:7`](https://github.com/whatsgood200/spillway/blob/main/web/src/app/api/history/route.ts#L7) |
| Security headers: CSP, HSTS, no framing | [`next.config.ts:15-32`](https://github.com/whatsgood200/spillway/blob/main/web/next.config.ts#L15-L32) |
| The price shown for selling a place is the contract quote for that place | [`real.ts:377-380`](https://github.com/whatsgood200/spillway/blob/main/web/src/lib/chain/real.ts#L377-L380) |
