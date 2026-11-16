// Records the live product for the demo video. Every clip is the real site on Base Sepolia, unedited.
// Run from video/:  node record.mjs [demo] [wallet] [latency] [hostile]
// The demo account key stays inside web/scripts/lib/live.mjs; the cash-out wallet is created in memory here,
// signs in Node, and is never written anywhere.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { clickOn, glide, hover, openBrowser, sleep, startCapture } from "./lib/capture.mjs";

const SITE = "https://spillway-phi.vercel.app";
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["demo", "wallet", "latency", "hostile"]);
mkdirSync("out/clips", { recursive: true });
const marksFile = "out/clips/marks.json";
const marks = existsSync(marksFile) ? JSON.parse(readFileSync(marksFile, "utf8")) : {};
const save = () => writeFileSync(marksFile, JSON.stringify(marks, null, 2));

const { browser, context } = await openBrowser();

async function settle(page, ms = 1200) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(ms);
}

if (want.has("demo")) {
  const page = await context.newPage();
  await page.goto(`${SITE}/demo`);
  await settle(page, 2500);
  const clip = await startCapture(page, "demo");
  await sleep(1500);
  await clickOn(page, page.getByRole("button", { name: /^Queue a .* USDC withdrawal$/ }));
  clip.mark("queueClicked");
  const queued = page.getByText(/^Queued as request \d+/);
  await queued.waitFor({ timeout: 90_000 });
  clip.mark("queued");
  const requestId = (await queued.textContent()).match(/request (\d+)/)[1];
  await sleep(2200);
  await clickOn(page, page.getByRole("button", { name: /^Repay 2 USDC$/ }));
  clip.mark("repayClicked");
  await page.getByText(/^Repaid 2 USDC/).waitFor({ timeout: 90_000 });
  clip.mark("repaid");
  await sleep(900);
  await clickOn(page, page.getByRole("link", { name: `Open request ${requestId}` }));
  await page.waitForURL(`**/claim/${requestId}`);
  clip.mark("claimOpened");
  await page.getByText(/after a repayment landed\./).waitFor({ timeout: 120_000 });
  clip.mark("paidShown");
  const headline = (await page.locator(".headline-stat").first().textContent()).trim();
  await sleep(3500);
  await glide(page, 420, 1800);
  await sleep(1200);
  for (const name of ["A repayment landed in the vault", "Reactive Network saw it and called the vault", "The vault paid this request"]) {
    await hover(page, page.getByText(name));
    await sleep(1100);
  }
  clip.mark("timelineShown");
  await sleep(1500);
  const lasnaHref = await page.locator('a[href*="reactscan"]').first().getAttribute("href");
  const result = await clip.stop();
  marks.demo = { ...result, requestId, headline, lasnaHref };
  save();

  // The reactive transaction on the Reactive Lasna explorer.
  await page.goto(lasnaHref);
  await settle(page, 3500);
  const explorer = await startCapture(page, "lasna");
  await sleep(1200);
  await glide(page, 260, 1600);
  await sleep(3500);
  marks.lasna = { ...(await explorer.stop()), url: lasnaHref };
  save();
  await page.close();
}

if (want.has("wallet")) {
  // A fresh wallet, funded by the demo account, used only for this clip.
  const live = await import("../web/scripts/lib/live.mjs");
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key);
  const signer = createWalletClient({ account: me, chain: baseSepolia, transport: http("https://sepolia.base.org", { retryCount: 4, retryDelay: 800 }) });
  const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function deposit(uint256,address) returns (uint256)"]);
  const wait = (hash) => live.pub.waitForTransactionReceipt({ hash });
  const headroom = async (request) => ((await live.pub.estimateContractGas({ ...request, account: request.account })) * 3n) / 2n + 60_000n;
  console.log(`  wallet ${me.address}: funding`);
  await wait(await live.wallet.sendTransaction({ to: me.address, value: parseEther("0.0015") }));
  const transfer = { address: live.A.usdc, abi: erc20, functionName: "transfer", args: [me.address, 1_200_000n], account: live.account };
  await wait(await live.wallet.writeContract({ ...transfer, gas: await headroom(transfer) }));
  const approve = { address: live.A.usdc, abi: erc20, functionName: "approve", args: [live.A.vault, 1_100_000n], account: me };
  await wait(await signer.writeContract({ ...approve, gas: await headroom(approve) }));
  const deposit = { address: live.A.vault, abi: erc20, functionName: "deposit", args: [1_100_000n, me.address], account: me };
  await wait(await signer.writeContract({ ...deposit, gas: await headroom(deposit) }));
  console.log("  wallet funded and deposited 1.1 USDC");
  // Track the nonce here: the load-balanced public RPC can report a stale one.
  const fresh = createPublicClient({ chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com") });
  let nonce = await fresh.getTransactionCount({ address: me.address, blockTag: "pending" });

  let connected = false;
  const sent = [];
  await context.exposeBinding("__wallet", async (_source, method, params) => {
    if (method === "eth_requestAccounts") return (connected = true), [me.address];
    if (method === "eth_accounts") return connected ? [me.address] : [];
    if (method === "eth_chainId") return "0x14a34";
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    if (method === "eth_sendTransaction") {
      const tx = params[0];
      const hash = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gas: tx.gas ? BigInt(tx.gas) : undefined, nonce: nonce++ });
      sent.push(hash);
      return hash;
    }
    return live.pub.request({ method, params });
  });
  await context.addInitScript(() => {
    window.ethereum = { on() {}, removeListener() {}, request: ({ method, params }) => window.__wallet(method, params ?? []) };
  });

  // Off camera: the demo borrower lends out every idle dollar, so a withdrawal has to queue.
  const page = await context.newPage();
  await page.goto(`${SITE}/demo`);
  await settle(page, 2000);
  await page.getByRole("button", { name: "Borrow all idle cash again" }).click();
  await page.getByText(/^Borrowed every dollar/).waitFor({ timeout: 90_000 });

  await page.goto(SITE);
  await settle(page, 2500);
  const clip = await startCapture(page, "wallet");
  await sleep(1200);
  await clickOn(page, page.getByRole("button", { name: "Connect wallet" }).first());
  await page.getByText(/In the vault: 1\.10 USDC/).waitFor({ timeout: 30_000 });
  clip.mark("connected");
  await sleep(1000);
  const amount = page.locator("#withdraw-amount");
  await clickOn(page, amount);
  await amount.fill("");
  await amount.pressSequentially("1", { delay: 120 });
  await page.getByRole("button", { name: /^Get .* USDC now$/ }).waitFor();
  await sleep(700);
  // Bring the quote to the middle of the screen, clear of the captions.
  const panel = await page.locator('section[aria-label="Your withdrawal"]').boundingBox();
  await glide(page, panel.y - 70, 1400);
  await sleep(500);
  clip.mark("quoteShown");
  for (const label of ["You give up", "Back right away", "Fee to the pool", "Most you can lose"]) {
    await hover(page, page.getByText(label, { exact: true }).first());
    await sleep(900);
  }
  await clickOn(page, page.getByRole("button", { name: /^Get .* USDC now$/ }));
  clip.mark("cashOutClicked");
  await page.waitForURL("**/claim/**", { timeout: 120_000 }).catch(async (error) => {
    await page.screenshot({ path: "out/wallet-failure.png" });
    console.log("  page said:", (await page.locator(".error, [role=alert], .tx-note").allTextContents()).join(" | "), "sent:", sent);
    throw error;
  });
  await page.getByText(/now\.$/).first().waitFor({ timeout: 60_000 });
  clip.mark("cashedOut");
  const headline = (await page.locator(".headline-stat").first().textContent()).trim();
  await sleep(4000);
  marks.wallet = { ...(await clip.stop()), address: me.address, headline, txs: sent };
  save();
  await page.close();
}

if (want.has("latency")) {
  const page = await context.newPage();
  await page.goto(`${SITE}/latency`);
  await settle(page, 3500);
  const clip = await startCapture(page, "latency");
  await sleep(2500);
  await glide(page, 700, 2200);
  await sleep(2500);
  await page.locator('section[aria-label="Real data from Base mainnet"]').scrollIntoViewIfNeeded();
  const box = await page.locator('section[aria-label="Real data from Base mainnet"]').boundingBox();
  await glide(page, box.y - 120, 2000);
  clip.mark("realData");
  await sleep(6000);
  marks.latency = await clip.stop();
  save();
  await page.close();
}

if (want.has("hostile")) {
  // The real output of three stranger calls against the live contracts.
  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const run = (args) => {
    try {
      return execFileSync("cast", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      return String(error.stderr || error.message).trim().split("\n").filter((line) => line.includes("revert")).join(" ");
    }
  };
  marks.hostile = [
    {
      what: "A stranger calls the callback",
      command: `cast call SpillwayCallback "settle(...)" --from 0x…dEaD`,
      output: run(["call", "0x6C78012f837B5A4602c9098D68e95F070018823D", "settle(address,uint256,uint256,uint256)", "0x943d4252c759249D24D375E855B0a3caf13DB874", "0", "0", "4", "--from", DEAD, "--rpc-url", "https://sepolia.base.org"]),
      decoded: "NotAuthorized(sender, callback proxy)",
    },
    {
      what: "A stranger mints collateral to borrow",
      command: `cast call RestrictedCollateral "mint(...)" --from 0x…dEaD`,
      output: run(["call", "0x5Cab8749ec7F208e19211381FD185dC6e448D857", "mint(address,uint256)", DEAD, "1000000000000000000", "--from", DEAD, "--rpc-url", "https://sepolia.base.org"]),
      decoded: "NotApproved(0x…dEaD)",
    },
    {
      what: "A stranger feeds the reactor a fake event",
      command: `cast call QueueReactor "react(...)" --from 0x…dEaD   # on Lasna`,
      output: run(["call", "0x943d4252c759249D24D375E855B0a3caf13DB874", "react((uint256,address,uint256,uint256,uint256,uint256,bytes,uint256,uint256,uint256,uint256,uint256))", `(84532,${DEAD},0,0,0,0,0x,0,0,0,0,0)`, "--from", DEAD, "--rpc-url", "https://lasna-rpc.rnk.dev/"]),
      decoded: "NotAuthorized(sender, system contract)",
    },
  ];
  save();
  console.log(marks.hostile.map((h) => `${h.what}: ${h.output.slice(0, 90)}`).join("\n"));
}

await browser.close();
console.log(JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v.marks ?? v.headline ?? "ok"])), null, 2));
