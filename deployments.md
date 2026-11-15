<!-- Record every address and transaction the moment it lands. This file feeds README.md, JUDGES.md and the submission form. -->

# Deployments

Reactive Omni Buildathon, deployed 2026-11-15. Deployer: `0xd4171f06da70216e0bb1069e41907f3d6723a097`.

## Base Sepolia (chain 84532), explorer https://sepolia.basescan.org

| Contract | Address | Deploy transaction | Source verified |
|---|---|---|---|
| QueueVault | `0x0CD16Bb4d327e2bA0947deE279073cEc2E0DA265` | `0xf48c1a3ee5fe55fa874e89e3271dbfdaf031d3440f6c7b7ddbe597787bb3e052` | no |
| InstantPool | `0xD8f888161FAcB6529e9389B2b1b9E3Df2636957e` | `0xbfb1d05aa2a5ec4fd9b1144b2fb5077d3caa39fd86ab8e3648b0705c1543178b` | no |
| DemoCollateral (sdCOL, ours, freely mintable) | `0xd7F44463230e95f6b490Da29b8bc475De25C98AB` | `0x3ccf3c2c0c5cfb6afe706732976843f2f14187f4f674d625fa67cfc82eaeea5f` | no |
| DemoOracle (ours, fixed price) | `0x5adeA92852259009Fd5664F12aC13aBC74f9Fb77` | `0xa1dcfb91d2ee35339fcbde7999ee9f8771d520f69a171cca61edf55d49921060` | no |
| SpillwayCallback | pending | pending | no |

Morpho Blue market created by us on the deployed Morpho Blue (`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`): id `0x521b1156d589a7aa2e41ef70a44a075b46c81605a4b00e8b036de52fe9344d9b`, loan token USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Adaptive Curve IRM, LLTV 86 percent. Create transaction `0xf0f366f77cca4700d0428923e9d3d9da09471686bede81f2608ffc12a1aeb9f6`.

lREACT funding: 0.2 ETH sent to the Reactive faucet contract, transaction `0xe1a64a1a7baba0c32c7205a006d055bbce18579c443a8dae8b1f12938235fc31`; 20 lREACT received on Lasna.

Checked on chain 2026-11-15: vault asset, Morpho address and market id match; pool points at the vault; collateral symbol and oracle price read correctly.

## Reactive Lasna (chain 5318007), explorer https://lasna.reactscan.net

| Contract | Address | Deploy transaction | Source verified |
|---|---|---|---|
| QueueReactor | `0x45805145536767435185c991097D8193A8518581` | `0x167e956d3db0ab44e286e2396f435994976eece8c9c9876780c03b4ef8fe9390` | no |

## One full lifecycle on chain

<!-- Run this before submitting. Every step is a clickable transaction. -->

| Step | Transaction |
|---|---|
| Create or mint | `<tx>` |
| Use | `<tx>` |
| Settle | `<tx>` |
| Redeem or withdraw | `<tx>` |
| Replay or bad input | **Refused**: `<tx or test>` |

These are our own transactions made to show the flow. They are not user traction.

## Sponsor integrations

| Sponsor | What | Address, id or transaction |
|---|---|---|
| <sponsor> | <market, workflow, feed, index> | `<value>` |

## Reproduce

```
<the exact deploy and seed commands, with env names only>
```
