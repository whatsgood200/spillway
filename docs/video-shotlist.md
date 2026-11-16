# Video shot list: Spillway

Technical demo, 2:44 (limit 3:00), 1920 x 1080, 30 fps, narration at -16 LUFS. No burned-in captions, so nothing covers the product; a timed subtitle file (`video/out/spillway-demo.srt`) is uploaded with the video so viewers can turn captions on. Built entirely from code in [video/](../video): every live shot is the real site on Base Sepolia, recorded by a script, unedited except for trims and the clearly labelled speed-ups of waiting stretches.

## Final cut

| Time | Segment | On screen | Words |
|---|---|---|---|
| 0:00 | problem | Scene: a vault filling with loans to 99.4 percent lent out; the failed withdrawal; the Gauntlet event card | Lending vaults lend out almost everything you deposit. When borrowing is heavy, the vault runs dry, and your withdrawal simply fails. In November 2025, two Gauntlet vaults on Morpho stayed under 1% withdrawable, for about six hours. |
| 0:16 | data | Scene: our Base mainnet data, 135 repayments into a dry market, each plotted by how long its cash waited, against the Spillway line at about 1.5 s | What happens when a borrower finally repays? We measured it, on Base mainnet. Over the last year, borrowers repaid into a dry Morpho market 135 times. Nobody was in line for that cash. It was taken a median of 1.6 hours later, first come, first served. |
| 0:36 | intro | Scene: logo, one line, Morpho Blue, Reactive Network, Base | Spillway puts lenders in line, and the line pays itself. The moment a borrower repays, a Reactive contract pays everyone waiting, in order, in about 1.5 seconds. |
| 0:49 | demo | Live: demo page, Queue a 2 USDC withdrawal, Repay 2 USDC, the request turns to Paid 2.00 USDC, 1.6 s, with its three transactions | This is the live app, on Base Sepolia. No wallet needed. I queue a 2 USDC withdrawal. The vault is fully lent out, so it waits in line. Now the borrower repays. That's all. Nobody touches the vault. Open the request. Paid, 1.6 seconds after the repayment landed. Three transactions: the repayment on Base, the reactive transaction on Reactive Lasna, and the payout, back on Base. |
| 1:19 | lasna | Live: the reactive transaction on lasna.reactscan.net, its callback to Base Sepolia confirmed | On the Reactive explorer, you can see the callback it sent to Base, confirmed. |
| 1:25 | wallet | Live, real wallet: Withdraw page, connect, 1 USDC, the cash-now quote, Get 0.9951 USDC now, paid | Rather not wait at all? Sell your place to the pool. Before you sign, you see what you give up, what comes back right away, the fee, and the most you can lose. One click. The wallet signs an approval, then the sale. And the cash is already in your wallet. |
| 1:46 | how | Scene: repayment, QueueReactor on Lasna, callback proxy, QueueVault; the queue paid from the front; 1.4 s measured | Here's how it works. On Reactive Lasna, our reactor listens for one thing: an approved borrower repaying its own loan, in our Morpho market. It calls back through Reactive's proxy to Base, where our contract pays the queue, first in, first out, and records the time in milliseconds. |
| 2:06 | hostile | Scene: real reverts from the live contracts as a stranger, then 77 tests passed | And it's built to resist abuse. A stranger can't call the callback, can't mint collateral to borrow, and can't feed the reactor a fake event. Each is refused on chain. 77 tests attack every finding in our threat model. |
| 2:22 | latency | Live: the latency page, measured loops | Every loop is timed on chain. On the current contracts, the median is 1.4 seconds. |
| 2:29 | close | Scene: honest limits, next step, the URL, a dare | Spillway runs on testnets today, with test funds and our own Morpho market. Next: a real market, with a curator. Try it at spillway-phi.vercel.app. And try to break it. |

## Production

- **Live footage:** `video/record.mjs` drives the live site in Chromium at 1920 x 1080 and captures it frame by frame through the DevTools screencast, so text stays sharp. The demo clip uses the demo console (no wallet). The cash-out clip uses a fresh wallet created in memory, funded with 1.2 test USDC by the demo account, signing in Node; its key is never written anywhere. A cursor and click rings are drawn because a headless browser shows none.
- **Scenes:** `video/scenes/scenes.html`, in the site's own fonts and colours. Every frame is a pure function of time, rendered one at a time, so scenes are identical on every build and land on the narration's cue times. The real-data scene plots all 135 events from `measurements/morpho-base-2026-11-16.json`; the abuse scene shows revert output captured from the live contracts.
- **Voice:** Kokoro (open model, Apache-2.0, voice `af_heart`), rendered locally one sentence at a time, so captions match the speech exactly.
- **Assembly:** `video/build.mjs` lays out the timeline from `video/script.json`, the voice lengths and the moments recorded during capture (when a button was clicked, when the payout appeared), then cuts and mixes with ffmpeg. It writes the subtitle file from the same timings; `"burnCaptions": true` in `script.json` burns them into the picture instead.

## Rebuild

```bash
cd video && pnpm install
node record.mjs        # live clips; spends about 1.2 test USDC and 0.0015 test ETH from the demo account
node build.mjs         # out/spillway-demo.mp4, after the narration is in video/audio/
```

The narration is rendered with Kokoro, installed outside the repo: `python batch.py video/script.json video/audio`.

## Rules followed

- Live product only in the demo segments; scenes explain, they never stand in for the product.
- Never cut between an action and its confirmed result. Waiting stretches play faster, and say so on screen.
- One honest limit on screen at the end: testnets, test funds, our own Morpho market, not audited.

## Still to do

- Upload unlisted to YouTube with `spillway-demo.srt` as English subtitles, test the link in a private window, put it in the submission and the README.
