<!-- Record every address and transaction the moment it lands. This file feeds README.md, JUDGES.md and the submission form. -->

# Deployments

Reactive Omni Buildathon. Current deployment (v3) made 2026-11-16. Deployer: `0xd4171f06da70216e0bb1069e41907f3d6723a097`.

v3 is the hardened release: every finding in [docs/threat-model.md](docs/threat-model.md) is fixed, each with an attack test. Source verified 2026-11-16 with Solidity 0.8.31, optimizer 200 runs, EVM cancun.

Every hash below was checked against the chain with `eth_getTransactionByHash` and `eth_getTransactionReceipt` (what it created, or which contract and function it called). The deploy tool's own printout pairs some hashes with the wrong step, so its output is not copied directly.

## Current (v3): Base Sepolia (chain 84532), explorer https://sepolia.basescan.org

| Contract | Address | Deploy transaction | Source verified |
|---|---|---|---|
| QueueVault | `0x8a430D6472Fbf703233BA5083e134B490d2f60F6` | `0x3ff0704a3f051a31a08d78109427bc76d1fc8d00ec83a1375869a0dbcd773408` | [Basescan](https://sepolia.basescan.org/address/0x8a430D6472Fbf703233BA5083e134B490d2f60F6#code), [Sourcify](https://repo.sourcify.dev/84532/0x8a430D6472Fbf703233BA5083e134B490d2f60F6) |
| InstantPool | `0x13d683F223E908A7BA615e4498fa5b4E392D3334` | `0x2d2d602ee6dd3b00904eada4419c09ba4337052e7fec9d3ce1da008dc1a98b1f` | [Basescan](https://sepolia.basescan.org/address/0x13d683F223E908A7BA615e4498fa5b4E392D3334#code), [Sourcify](https://repo.sourcify.dev/84532/0x13d683F223E908A7BA615e4498fa5b4E392D3334) |
| SpillwayCallback | `0x6C78012f837B5A4602c9098D68e95F070018823D` | `0x05d457a40c7ca602ccd46a6036dab96339511d8cb98b9d9f2491143b1424e927` | [Basescan](https://sepolia.basescan.org/address/0x6C78012f837B5A4602c9098D68e95F070018823D#code), [Sourcify](https://repo.sourcify.dev/84532/0x6C78012f837B5A4602c9098D68e95F070018823D) |
| RestrictedCollateral (sdCOL; only approved accounts can mint or hold it) | `0x5Cab8749ec7F208e19211381FD185dC6e448D857` | `0xa4da04408349cddc466b14b00237decad5aac1c770cf502edc87333f1642fe13` | [Basescan](https://sepolia.basescan.org/address/0x5Cab8749ec7F208e19211381FD185dC6e448D857#code), [Sourcify](https://repo.sourcify.dev/84532/0x5Cab8749ec7F208e19211381FD185dC6e448D857) |
| DemoOracle (fixed price) | `0xefe22F067C4847a1bC45DCd6fF2eB2A8b6d48065` | `0xac6c451f397d7a2458302acf31d364964673f71eabc3d445823dd15f34d5f06e` | [Basescan](https://sepolia.basescan.org/address/0xefe22F067C4847a1bC45DCd6fF2eB2A8b6d48065#code), [Sourcify](https://repo.sourcify.dev/84532/0xefe22F067C4847a1bC45DCd6fF2eB2A8b6d48065) |

Morpho Blue market created by us on the deployed Morpho Blue (`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`): id `0xf292f6924b2a0311cd8530d19d6d0edd9b7447a5bab1c1bd1663d49a14d6000c`, loan token USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, collateral sdCOL, oracle DemoOracle, Adaptive Curve IRM `0x46415998764C29aB2a25CbeA6254146D50D22687`, LLTV 86 percent. Create transaction `0x1aa86f617b36cf2a7b50715fcde6669c5c0f4e96b15b260122778d5d2e8e109d`.

Approved borrowers (the only accounts that can mint or hold sdCOL, and the only repayments the reactor watches): the deployer `0xd4171f06da70216e0bb1069e41907f3d6723a097` and the demo account `0x030ACe00e679c850cF01c6eE596bbFbf157fB931`.

## Current (v3): Reactive Lasna (chain 5318007), explorer https://lasna.reactscan.net

| Contract | Address | Deploy transaction | Source verified |
|---|---|---|---|
| QueueReactor | `0x943d4252c759249D24D375E855B0a3caf13DB874` | `0x3230a436a0e8d43dccc94d9baffe304ceed9d722045ce80cb8103ca74b913525` | [Sourcify](https://repo.sourcify.dev/5318007/0x943d4252c759249D24D375E855B0a3caf13DB874) exact match |

Reactor wired to the callback contract: `0xf1c9865c2a5812aa71e610998d9505349f35400f3c8148b693a7d955db8bcbe0`.

Checked on chain 2026-11-16: the collateral approves only the two borrowers and Morpho (a stranger address returns false); the market uses that collateral and oracle; pool and callback point at the vault; the callback accepts only the Base Sepolia callback proxy (`0x476F44b11F5C942c58f4c8E3d0300E5710743585`) acting for the reactor; the reactor is active, watches the same market id, lists the two approved borrowers, holds 2 lREACT with no debt; the callback holds 0.01 ETH.

Measured on v3: see [measurements/README.md](measurements/README.md) and `measurements/loops-v3-2026-11-16.jsonl`.

## Retired (v2), deployed 2026-11-16

Replaced by v3 to close the findings in the threat model. v2 is still on chain; nothing points at it, and its remaining gas funds were withdrawn. The 204-loop measurement and the race experiment were made on v2.

| Contract | Chain | Address |
|---|---|---|
| QueueVault | Base Sepolia | `0xa24C70baa119B2430CbC2Fe770874fd3A10db1b0` |
| InstantPool | Base Sepolia | `0x15d5F39A464875634349a88c5E9F48D84f603207` |
| SpillwayCallback | Base Sepolia | `0xfCA6031Dd3655CdB2B6D47F0A84F3e3e7c812C20` |
| QueueReactor | Reactive Lasna | `0x5adeA92852259009Fd5664F12aC13aBC74f9Fb77` |
| Morpho market id | Base Sepolia | `0x29c415df812658c358fbd137cb13745f337bdec8c043cb7f3247274a80115631` |

## One full lifecycle on chain (v2)

First v2 loop, 2026-11-16, started from the web app's demo console (demo account `0x030ACe00e679c850cF01c6eE596bbFbf157fB931`):

| Step | Chain | Transaction |
|---|---|---|
| Demo lender deposits 2 USDC | Base Sepolia | `0xc892412527c0a443a66e91b52309cf40772822f72d8ffb272b7664a5d5f55c9b` |
| Demo borrower borrows all of it (vault 100 percent lent out) | Base Sepolia | `0xaeec8b8232acc2faac525bee6cba6112aa70d90e9c4fa415c6d3a7d0a320d345` |
| Withdrawal queued as request 1 (block 59470304) | Base Sepolia | `0x1e632f09218f238abefe26e8355792fd8e82dfe0fe2df932c3750b5bb1ee40c2` |
| Demo borrower repays 2 USDC (origin event, block 59470327, 1794815934200 ms) | Base Sepolia | `0x9a9834231faa36165e83c8342d13240b544421fff6b296fda7188899a71eb3ed` |
| Reactive contract requests the callback | Reactive Lasna | `0x2707fa2e2431555896fb929d8e79a5011366d1007e664a65cfcaab0725bd4218` |
| Callback pays request 1 (block 59470337, 1794815936200 ms) | Base Sepolia | `0x41a262da466f549441d053d69e1b98ae17f965378c8d386f0d2d405931b55251` |

Repayment to payout: 2,000 ms (10 Base Sepolia blocks). Recorded in `SpillwayCallback.loops(0)` and `QueueVault.requests(1)`.

200-loop measurement, 2026-11-16: 204 loops recorded in `SpillwayCallback` storage, median 1.6 s, p90 2.4 s, p99 4.0 s. Method, failures and every transaction: `measurements/README.md` and `measurements/loops-2026-11-16.jsonl`.

These are our own transactions made to show the flow. They are not user traction.

## Funding

lREACT: 0.2 ETH sent to the Reactive faucet contract on Base Sepolia, transaction `0xe1a64a1a7baba0c32c7205a006d055bbce18579c443a8dae8b1f12938235fc31`; 20 lREACT received on Lasna.

## Retired (v1), deployed 2026-11-15

Replaced because v1 kept no history in storage, so the app depended on a rate-limited third-party indexer. v1 is still on chain and still works; nothing points at it. Its gas funds (1.94 lREACT in the reactor, 0.01 ETH in the callback) cannot be withdrawn, since v1 had no withdrawal function.

| Contract | Chain | Address |
|---|---|---|
| QueueVault | Base Sepolia | `0x0CD16Bb4d327e2bA0947deE279073cEc2E0DA265` |
| InstantPool | Base Sepolia | `0xD8f888161FAcB6529e9389B2b1b9E3Df2636957e` |
| SpillwayCallback | Base Sepolia | `0x2C0aecdBef8B4CB99461C53a17811B104D2F17C5` |
| QueueReactor | Reactive Lasna | `0x45805145536767435185c991097D8193A8518581` |
| Morpho market id | Base Sepolia | `0x521b1156d589a7aa2e41ef70a44a075b46c81605a4b00e8b036de52fe9344d9b` |

### First live loop (v1), 2026-11-15

| Step | Chain | Transaction |
|---|---|---|
| Deposit 5 USDC into the vault | Base Sepolia | `0x9b54cf384b9572a5ee1ed2c1626283fa308511275af255fabc37d8e1ab1e9385` |
| Demo borrower borrows all 5 USDC (vault 100 percent lent out) | Base Sepolia | `0x0e6b1a747b44f1ea122c380515059d0fece2d844c55871759955aaecf3749a37` |
| Withdrawal requested and queued as request 1 | Base Sepolia | `0xcdc57dbe4eadf1dc3cfc860c6cec502855b92af1c7cbfe0fd51bc33a7abbe54f` |
| Demo borrower repays 5 USDC (origin event, block 59303697, 1794782608200 ms) | Base Sepolia | `0x1ba8d9e8db14848011a9ac119e351316315203960fb717d30a15fb55c5898577` |
| Reactive contract reacts and requests the callback (block 8442934) | Reactive Lasna | `0xdd56bdf581656aada4f2909568cdaace8c1706ec1db0c1d940e65a73c86eb275` |
| Callback pays request 1, sent by Reactive's signer through the callback proxy (block 59303703, 1794782609400 ms) | Base Sepolia | `0x337000876ee11c33b79a42935b070ee211f4885e1a502b9779a27247fa536482` |

Repayment to payout: 1,200 ms (6 Base Sepolia blocks), from the two blocks' millisecond timestamps.

## Sponsor integrations

| Sponsor | What | Address, id or transaction |
|---|---|---|
| Reactive Network | QueueReactor on Lasna subscribes to Morpho Blue `Repay` (only when an approved borrower repays its own loan) and `Liquidate` of an approved borrower on our market, and to its callback's `LoopClosed`; it requests callbacks to Base Sepolia that pay the queue | `0x943d4252c759249D24D375E855B0a3caf13DB874` |
| Morpho Blue (live protocol, not a sponsor) | The vault lends on a market we created on the deployed Morpho Blue | market `0xf292f692…14d6000c` |

## Reproduce

From `contracts/`, with an encrypted Foundry keystore named `spillway`. Approved borrowers default to the deployer and the demo account; set `BORROWERS=0x..,0x..` to change them.

```
forge script script/Deploy.s.sol:DeployOrigin   --rpc-url base_sepolia --account spillway --sender <deployer> --broadcast
MARKET_ID=<market id> forge script script/Deploy.s.sol:DeployReactor --rpc-url lasna --account spillway --sender <deployer> --broadcast
VAULT=<vault> REACTOR=<reactor> forge script script/Deploy.s.sol:DeployCallback --rpc-url base_sepolia --account spillway --sender <deployer> --broadcast
REACTOR=<reactor> CALLBACK=<callback> forge script script/Deploy.s.sol:WireReactor --rpc-url lasna --account spillway --sender <deployer> --broadcast
```
