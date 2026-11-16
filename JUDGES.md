# Spillway for judges: try it in three minutes

Spillway is a withdrawal queue for a fully lent-out lending vault that pays waiting lenders, in order, about 1.5 seconds after a borrower repays, triggered by a Reactive contract with no keeper. It runs on Base Sepolia and Reactive Lasna with test USDC.

**Open:** https://spillway-phi.vercel.app/demo (phone or desktop)

## 1. Get in (no wallet, no gas)

Nothing to sign in to. The demo page drives a labelled demo account on Base Sepolia from the server, so every button below makes real transactions without a wallet.

## 2. Watch a repayment pay the queue (2 minutes)

1. Press **Queue a 2 USDC withdrawal**. The demo lender deposits, the demo borrower borrows every dollar the market can release, and the lender asks to withdraw. With no cash left, the request queues. A note says `Queued as request N`.
2. Press **Repay 2 USDC**. That is the only thing that happens: the borrower repays Morpho Blue. Nobody calls the vault.
3. Open the request with **Open request N**. Within a few seconds it reads `Paid 2.00 USDC, 1.4 s after a repayment landed.` with three transactions:
   - the repayment on Base Sepolia,
   - the reactive transaction on Reactive Lasna (our `QueueReactor` saw the `Repay` event and requested the callback),
   - the payout on Base Sepolia (`SpillwayCallback` called `QueueVault.settle`).

   Each opens on its explorer. If someone else was already waiting, their request is paid first; press **Repay 2 USDC** again.

## 3. Check it is real (30 seconds)

- **https://spillway-phi.vercel.app/latency**: every loop measured on chain, the distribution, and the race experiment (a competitor landing 1.6 s or more after a repayment lost the cash to the queue 22 of 24 times).
- The loop record is in contract storage, readable with no key:

  ```bash
  cast call 0x6C78012f837B5A4602c9098D68e95F070018823D "loopCount()(uint256)" --rpc-url https://sepolia.base.org
  ```

- Source is verified on Basescan and Sourcify; addresses in [deployments.md](deployments.md).

## 4. Try to break it (optional)

- On the demo page, press **Repay 2 USDC** when nobody is waiting. It is refused: `Nobody is waiting, so a repayment would not pay anyone.` (a repayment that pays nobody would only burn Reactive gas).
- Call our callback contract yourself. It reverts with `NotAuthorized`: only the Reactive callback proxy, acting for our reactor, can call it.

  ```bash
  cast call 0x6C78012f837B5A4602c9098D68e95F070018823D "settle(address,uint256,uint256,uint256)" 0x943d4252c759249D24D375E855B0a3caf13DB874 0 0 4 --from 0x000000000000000000000000000000000000dEaD --rpc-url https://sepolia.base.org
  ```

- More refusals, each with a command: [docs/claims.md](docs/claims.md#what-refuses-and-how-to-see-it-yourself).

## 5. With a wallet (optional)

Any wallet on Base Sepolia with a little ETH and test USDC ([Circle faucet](https://faucet.circle.com/)) can use the main page: **Deposit**, then on **Withdraw** choose **Get … USDC now** (the pool buys your place for the fee shown) or **Join the queue**. A held place can be sold later from its request page with **Sell my place for … USDC**.

## Proof on chain

| What | Link |
|---|---|
| `QueueVault` (Base Sepolia) | [0x8a43…60F6](https://sepolia.basescan.org/address/0x8a430D6472Fbf703233BA5083e134B490d2f60F6#code) |
| `InstantPool` (Base Sepolia) | [0x13d6…3334](https://sepolia.basescan.org/address/0x13d683F223E908A7BA615e4498fa5b4E392D3334#code) |
| `SpillwayCallback` (Base Sepolia) | [0x6C78…823D](https://sepolia.basescan.org/address/0x6C78012f837B5A4602c9098D68e95F070018823D#code) |
| `QueueReactor` (Reactive Lasna) | [0x943d…B874](https://lasna.reactscan.net/address/0x943d4252c759249D24D375E855B0a3caf13DB874) |
| One loop: repayment, reactive transaction, payout (0.8 s) | [repay](https://sepolia.basescan.org/tx/0x6e541c1830d1653e559db79d1e12e39965d4d351bc04baa534d13546d5a118f6), [react](https://lasna.reactscan.net/tx/0x075fe32568a4d154a5f71eafadef26f27264a476142d70d0c2e248c33dfc0cd9), [payout](https://sepolia.basescan.org/tx/0x96bd2120da4e9556efe44884e40ab96918cc46cfc7b29cd1d6085153fc319e35) |
| A full lifecycle with a wallet: deposit, cash now, queue, sell a place, paid by Reactive, pool deposit and lock | [docs/claims.md](docs/claims.md#one-lifecycle-through-the-web-app-with-a-wallet-2026-11-16) |
| Every claim, with the line that enforces it and the test that attacks it | [docs/claims.md](docs/claims.md) |
| Every way in, and how it is closed | [docs/threat-model.md](docs/threat-model.md) |
