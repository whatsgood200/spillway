<!-- Record every address and transaction the moment it lands. This file feeds README.md, JUDGES.md and the submission form. -->

# Deployments

Reactive Omni Buildathon. Current deployment (v2) made 2026-11-16. Deployer: `0xd4171f06da70216e0bb1069e41907f3d6723a097`.

Every hash below was checked against the chain with `eth_getTransactionByHash` and `eth_getTransactionReceipt` (what it created, or which contract and function it called). The deploy tool's own printout pairs some hashes with the wrong step, so its output is not copied directly.

## Current (v2): Base Sepolia (chain 84532), explorer https://sepolia.basescan.org

| Contract | Address | Deploy transaction | Source verified |
|---|---|---|---|
| QueueVault | `0xa24C70baa119B2430CbC2Fe770874fd3A10db1b0` | `0x91a7f3c3c403ee703f9512df481f521620cf2cd0331339e9eb56a985d8235154` | no |
| InstantPool | `0x15d5F39A464875634349a88c5E9F48D84f603207` | `0x1553e50868b6fcd26e0cbbeec15152f7bf3883cf0cca55228892ed46b352cb59` | no |
| SpillwayCallback | `0xfCA6031Dd3655CdB2B6D47F0A84F3e3e7c812C20` | `0x29b1a71e6c166b3842f26e7a95b68f0387f4561fa049c83474e9d36b7ef085f2` | no |
| DemoCollateral (sdCOL, ours, freely mintable) | `0x9bdbfc3eC8659b3cB947162fa2a58a7837e4F806` | `0x55d3315947d86c43c7b16e0e588f5ddd3b8934b44a92ed38e619bf4ab73d28dd` | no |
| DemoOracle (ours, fixed price) | `0x02ae94417d2100B93C886e1A9f09139C60DC24A9` | `0x675b3a3d0ef865bb3a78741d48ad12df50fc3ad0b02e7c2c8ba1270c81e35b76` | no |

Morpho Blue market created by us on the deployed Morpho Blue (`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`): id `0x29c415df812658c358fbd137cb13745f337bdec8c043cb7f3247274a80115631`, loan token USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, collateral sdCOL, oracle DemoOracle, Adaptive Curve IRM `0x46415998764C29aB2a25CbeA6254146D50D22687`, LLTV 86 percent. Create transaction `0x0866f5c85d478b4f2e1c7c0c569b8a4c40345bc860a1d8dc6fb9e918023c6d7a`.

## Current (v2): Reactive Lasna (chain 5318007), explorer https://lasna.reactscan.net

| Contract | Address | Deploy transaction | Source verified |
|---|---|---|---|
| QueueReactor | `0x5adeA92852259009Fd5664F12aC13aBC74f9Fb77` | `0xb7b55fb9e29be8e25f32275a5cd62391f409281fbaf34620d6f1774ef466cc2f` | no |

Reactor wired to the callback contract: `0xe65f65571fc24078cfc5935c07d84ce04209d49eea6e020f8799f677edbd6bf9`.

Checked on chain 2026-11-16: vault lends USDC on the market above; pool and callback point at the vault; callback accepts only the Base Sepolia callback proxy (`0x476F44b11F5C942c58f4c8E3d0300E5710743585`) acting for the reactor; reactor points at the vault and the callback, pays up to 4 requests per callback, holds 2 lREACT with no debt; callback holds 0.01 ETH.

## One full lifecycle on chain (v2)

Not run yet on v2. The v1 loop below proves the mechanism; v2 adds on-chain history.

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
| Reactive Network | QueueReactor on Lasna subscribes to Morpho Blue Repay, Supply and Liquidate for our market, plus the vault's queue events, and requests callbacks to Base Sepolia | `0x5adeA92852259009Fd5664F12aC13aBC74f9Fb77` |
| Morpho Blue (live protocol, not a sponsor) | The vault lends on a market we created on the deployed Morpho Blue | market `0x29c415df…80115631` |

## Reproduce

From `contracts/`, with an encrypted Foundry keystore named `spillway`:

```
forge script script/Deploy.s.sol:DeployOrigin   --rpc-url base_sepolia --account spillway --sender <deployer> --broadcast
VAULT=<vault> MARKET_ID=<market id> forge script script/Deploy.s.sol:DeployReactor --rpc-url lasna --account spillway --sender <deployer> --broadcast
VAULT=<vault> REACTOR=<reactor> forge script script/Deploy.s.sol:DeployCallback --rpc-url base_sepolia --account spillway --sender <deployer> --broadcast
REACTOR=<reactor> CALLBACK=<callback> forge script script/Deploy.s.sol:WireReactor --rpc-url lasna --account spillway --sender <deployer> --broadcast
```
