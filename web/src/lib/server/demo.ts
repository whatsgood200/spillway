import "server-only";
import { createPublicClient, createWalletClient, decodeEventLog, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { serverTransport } from "./rpc";
import { ADDRESSES, MARKET_ID, callbackAbi, erc20Abi, morphoAbi, vaultAbi } from "../chain/config";

/**
 * The labelled demo account. It is a throwaway testnet wallet held by the server so a judge can cause a full
 * loop without a wallet of their own: it lends, borrows the vault dry, queues a withdrawal and repays.
 * Its transactions are ours and are labelled as ours everywhere they are shown.
 */

export class DemoError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export const MIN_DEMO_AMOUNT = 1_000_000n;
export const MAX_DEMO_AMOUNT = 5_000_000n;
// Daily caps, counted from the contracts' own storage so every server instance sees the same numbers.
// Each repayment by the demo account is one reaction on Reactive (about 0.06 lREACT with its callback), so
// 80 repayments a day is at most about 5 lREACT, and the reactor's pause switch remains the backstop.
const DAILY_QUEUE_CAP = 40;
const DAILY_REPAY_CAP = 80;
const COLLATERAL_TOP_UP = 10n * 10n ** 18n;

const publicClient = createPublicClient({ chain: baseSepolia, transport: serverTransport() });

let queue: Promise<unknown> = Promise.resolve();

function wallet() {
  const key = process.env.DEMO_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new DemoError("The demo account is not configured on this server.", 503);
  const account = privateKeyToAccount(key as Hex);
  return { account, client: createWalletClient({ account, chain: baseSepolia, transport: serverTransport() }) };
}

export function demoAddress(): string | null {
  try {
    return wallet().account.address;
  } catch {
    return null;
  }
}

function utcMidnightMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Requests the demo account made since midnight UTC, read from QueueVault storage, newest first. */
async function queuedToday(): Promise<number> {
  const { account } = wallet();
  const next = Number(await publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "nextRequestId" }));
  const since = utcMidnightMs();
  let count = 0;
  for (let end = next; end > 1; end -= 100) {
    const first = Math.max(1, end - 100);
    const page = await publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "requestsSlice", args: [BigInt(first), BigInt(end - first)] });
    for (const request of page) {
      if (Number(request.queuedAtMs) >= since && request.requester.toLowerCase() === account.address.toLowerCase()) count++;
    }
    if (page.length && Number(page[0].queuedAtMs) < since) break;
  }
  return count;
}

/** Loops paid since midnight UTC, read from SpillwayCallback storage, newest first. Every allowed demo repayment
 * pays someone (see `demoRepay`), so this counts them. */
async function loopsToday(): Promise<number> {
  const count = Number(await publicClient.readContract({ address: ADDRESSES.callback, abi: callbackAbi, functionName: "loopCount" }));
  const since = utcMidnightMs();
  let today = 0;
  for (let end = count; end > 0; end -= 100) {
    const first = Math.max(0, end - 100);
    const page = await publicClient.readContract({ address: ADDRESSES.callback, abi: callbackAbi, functionName: "loopsSlice", args: [BigInt(first), BigInt(end - first)] });
    for (const loop of page) if (Number(loop.paidAtMs) >= since) today++;
    if (page.length && Number(page[0].paidAtMs) < since) break;
  }
  return today;
}

async function checkCap(kind: "queue" | "repay") {
  const used = kind === "queue" ? await queuedToday() : await loopsToday();
  const cap = kind === "queue" ? DAILY_QUEUE_CAP : DAILY_REPAY_CAP;
  if (used >= cap) throw new DemoError("The demo account has reached its daily limit. Try again after midnight UTC.", 429);
}


/** One demo action at a time, so the account's transactions never race each other for a nonce. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

type Write = Parameters<ReturnType<typeof wallet>["client"]["writeContract"]>[0];

async function send(request: Write): Promise<{ hash: Hex; logs: { address: string; data: Hex; topics: Hex[] }[] }> {
  const { client, account } = wallet();
  // The public RPC sits behind several nodes, and an estimate from a node a block behind can be too low for the
  // path the transaction actually takes (seen as OutOfGas on requestRedeem). Give every estimate headroom.
  const estimate = await publicClient.estimateContractGas({ ...request, account } as never);
  const hash = await client.writeContract({ ...request, gas: (estimate * 3n) / 2n + 60_000n } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new DemoError(`A demo transaction reverted (${hash}).`, 502);
  return { hash, logs: receipt.logs as unknown as { address: string; data: Hex; topics: Hex[] }[] };
}

async function marketParams() {
  return publicClient.readContract({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "idToMarketParams", args: [MARKET_ID] });
}

async function approveIfNeeded(token: Hex, spender: Hex, needed: bigint) {
  const { account } = wallet();
  const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
  if (allowance < needed) {
    await send({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256], account, chain: baseSepolia });
  }
}

async function liquidity(): Promise<bigint> {
  const [supplyAssets, , borrowAssets] = await publicClient.readContract({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "market", args: [MARKET_ID] });
  return supplyAssets - borrowAssets;
}

async function borrowAll(): Promise<Hex | null> {
  const { account } = wallet();
  const params = await marketParams();
  const [, , collateral] = await publicClient.readContract({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "position", args: [MARKET_ID, account.address] });
  if (collateral < COLLATERAL_TOP_UP) {
    await send({ address: ADDRESSES.collateral, abi: erc20Abi, functionName: "mint", args: [account.address, COLLATERAL_TOP_UP], account, chain: baseSepolia });
    await approveIfNeeded(ADDRESSES.collateral, ADDRESSES.morpho, COLLATERAL_TOP_UP);
    await send({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "supplyCollateral", args: [params, COLLATERAL_TOP_UP, account.address, "0x"], account, chain: baseSepolia });
  }
  const available = await liquidity();
  if (available === 0n) return null;
  const { hash } = await send({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "borrow", args: [params, available, 0n, account.address, account.address], account, chain: baseSepolia });
  return hash;
}

function checkAmount(amount: bigint) {
  if (amount < MIN_DEMO_AMOUNT || amount > MAX_DEMO_AMOUNT) throw new DemoError("The demo amount must be between 1 and 5 USDC.", 400);
}

/** Demo lender deposits, the demo borrower takes every dollar the market can release, then the lender asks to withdraw. */
export function demoQueueWithdrawal(amount: bigint) {
  checkAmount(amount);
  return serial(async () => {
    await checkCap("queue");
    const { account } = wallet();
    const balance = await publicClient.readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (balance < amount) throw new DemoError("The demo account is out of test USDC. It needs a top-up.", 503);

    await approveIfNeeded(ADDRESSES.usdc, ADDRESSES.vault, amount);
    const deposit = await send({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "deposit", args: [amount, account.address], account, chain: baseSepolia });
    const borrowTx = await borrowAll();
    const shares = await publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "balanceOf", args: [account.address] });
    const request = await send({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "requestRedeem", args: [shares, account.address], account, chain: baseSepolia });

    let requestId: number | null = null;
    for (const log of request.logs) {
      if (log.address.toLowerCase() !== ADDRESSES.vault.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (decoded.eventName === "RedeemQueued") requestId = Number(decoded.args.requestId);
      } catch {
        // Share burn Transfer event.
      }
    }
    return { requestId, depositTx: deposit.hash, borrowTx, requestTx: request.hash };
  });
}

/** Demo borrower repays. This is the origin event of a loop; nothing here touches the vault. */
export function demoRepay(amount: bigint) {
  checkAmount(amount);
  return serial(async () => {
    await checkCap("repay");
    // Refuse a repayment when nobody waits: it would cost a reaction and pay no one.
    const waiting = await publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "queueLength" });
    if (waiting === 0n) throw new DemoError("Nobody is waiting, so a repayment would not pay anyone. Queue a withdrawal first.", 409);
    const { account } = wallet();
    const params = await marketParams();
    const [, , borrowAssets, borrowShares] = await publicClient.readContract({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "market", args: [MARKET_ID] });
    const [, myBorrowShares] = await publicClient.readContract({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "position", args: [MARKET_ID, account.address] });
    // Rounded down, so the repayment never exceeds the debt (Morpho reverts on overpayment).
    const owed = (myBorrowShares * (borrowAssets + 1n)) / (borrowShares + 1_000_000n);
    const repaying = amount < owed ? amount : owed;
    if (repaying === 0n) throw new DemoError("The demo borrower has nothing left to repay. Queue a withdrawal first.", 409);

    const balance = await publicClient.readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (balance < repaying) throw new DemoError("The demo account is out of test USDC. It needs a top-up.", 503);
    await approveIfNeeded(ADDRESSES.usdc, ADDRESSES.morpho, repaying);
    const { hash } = await send({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: "repay", args: [params, repaying, 0n, account.address, "0x"], account, chain: baseSepolia });
    return { repayTx: hash, repaid: repaying.toString() };
  });
}

export function demoBorrowIdle() {
  return serial(async () => {
    const borrowTx = await borrowAll();
    if (!borrowTx) throw new DemoError("The vault is already fully lent out.", 409);
    return { borrowTx };
  });
}
