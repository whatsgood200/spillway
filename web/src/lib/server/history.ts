import "server-only";
import { decodeEventLog, type Hex } from "viem";
import {
  ADDRESSES,
  BASE_DEPLOY_BLOCK,
  BASE_SEPOLIA_RPC,
  BLOCKSCOUT_API,
  LASNA_DEPLOY_BLOCK,
  LASNA_RPC,
  callbackAbi,
  poolAbi,
  reactorAbi,
  vaultAbi,
} from "../chain/config";

/**
 * Event history for the app, read server side so the browser never scans logs.
 *
 * Two sources feed one in-memory log store:
 * - The Base Sepolia RPC serves only 200 blocks of logs per call, so it covers the live tail (the last 40 s).
 * - Blockscout serves any range but rate limits, so it is asked rarely, and only for blocks not yet seen.
 * If either source fails, the page keeps showing what is already known.
 * Amounts are decimal strings because JSON has no bigint.
 */

export interface HistoryEvent {
  kind: "queued" | "settled" | "paid-at-once" | "transferred" | "bought";
  requestId: number;
  /** queued: receiver that owns the place. settled: who was paid. bought: the seller. */
  account: string;
  assets: string;
  paid?: string;
  fee?: string;
  txHash: string;
  block: number;
  atMs: number;
}

export interface HistoryLoop {
  id: number;
  originTx: string;
  originBlock: number;
  originMs: number;
  reactiveTx: string | null;
  payoutTx: string;
  payoutBlock: number;
  paidAtMs: number;
  latencyMs: number;
  settled: number;
  assets: string;
}

export interface History {
  events: HistoryEvent[];
  loops: HistoryLoop[];
  fetchedAtMs: number;
}

interface RawLog {
  address: string;
  blockNumber: string;
  data: Hex;
  topics: (Hex | null)[];
  transactionHash: string;
  logIndex: string;
}

const RESPONSE_CACHE_MS = 3_000;
const BLOCKSCOUT_EVERY_MS = 25_000;
const BLOCKSCOUT_BACKOFF_MS = 60_000;
const LASNA_EVERY_MS = 6_000;
const TAIL_BLOCKS = 190;
const WATCHED = [ADDRESSES.vault, ADDRESSES.pool, ADDRESSES.callback] as const;

const store = new Map<string, RawLog>();
const blockMsCache = new Map<number, number>();
const reactiveByOrigin = new Map<string, string>();
let backfilledTo = BASE_DEPLOY_BLOCK;
let backfilledOnce = false;
let blockscoutNotBefore = 0;
let lasnaNotBefore = 0;
let lasnaScannedTo = LASNA_DEPLOY_BLOCK;
let cached: { at: number; value: History } | null = null;
let inFlight: Promise<History> | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const body = (await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function remember(logs: RawLog[]) {
  for (const log of logs) store.set(`${log.transactionHash}:${Number(BigInt(log.logIndex))}`, log);
}

/** The last 40 seconds, straight from the chain. This is what makes a fresh payout appear at once. */
async function refreshTail() {
  const latest = Number(BigInt((await rpc(BASE_SEPOLIA_RPC, "eth_blockNumber", [])) as string));
  const logs = (await rpc(BASE_SEPOLIA_RPC, "eth_getLogs", [
    { address: WATCHED, fromBlock: `0x${(latest - TAIL_BLOCKS).toString(16)}`, toBlock: `0x${latest.toString(16)}` },
  ])) as RawLog[];
  remember(logs);
}

/** Everything older, from Blockscout, asked for only from the last block already covered. */
async function refreshBackfill() {
  if (Date.now() < blockscoutNotBefore) return;
  blockscoutNotBefore = Date.now() + BLOCKSCOUT_EVERY_MS;
  try {
    let highest = backfilledTo;
    for (const address of WATCHED) {
      let fromBlock = backfilledTo;
      // Blockscout returns at most 1,000 logs per call; page forward by block until a short page.
      for (let page = 0; page < 10; page++) {
        const body = (await fetchJson(`${BLOCKSCOUT_API}?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=latest&address=${address}`)) as {
          message?: string;
          result?: RawLog[] | null;
        };
        // An empty range is reported as "No logs found". Anything else without a list (a rate limit notice,
        // for example) is a failure and must not be mistaken for "nothing happened".
        if (!Array.isArray(body.result) && !/no (logs|records) found/i.test(body.message ?? "")) {
          throw new Error(`Blockscout: ${body.message ?? "unexpected response"}`);
        }
        const logs = Array.isArray(body.result) ? body.result : [];
        remember(logs);
        for (const log of logs) highest = Math.max(highest, Number(BigInt(log.blockNumber)));
        if (logs.length < 1000) break;
        fromBlock = Number(BigInt(logs[logs.length - 1].blockNumber));
      }
      await sleep(350);
    }
    backfilledTo = highest;
    backfilledOnce = true;
  } catch (cause) {
    blockscoutNotBefore = Date.now() + BLOCKSCOUT_BACKOFF_MS;
    if (!backfilledOnce) throw cause;
    console.warn("history backfill skipped", cause instanceof Error ? cause.message : cause);
  }
}

/** Reactive transactions on Lasna, matched to loops by the origin transaction hash they carry. */
async function refreshReactive() {
  if (Date.now() < lasnaNotBefore) return;
  lasnaNotBefore = Date.now() + LASNA_EVERY_MS;
  try {
    const logs = (await rpc(LASNA_RPC, "eth_getLogs", [
      { address: ADDRESSES.reactor, fromBlock: `0x${lasnaScannedTo.toString(16)}`, toBlock: "latest" },
    ])) as RawLog[];
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({ abi: reactorAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        const origin = `0x${decoded.args.originTxHash.toString(16).padStart(64, "0")}`;
        // The first request for an origin event is the one that started the loop.
        if (!reactiveByOrigin.has(origin)) reactiveByOrigin.set(origin, log.transactionHash);
        lasnaScannedTo = Math.max(lasnaScannedTo, Number(BigInt(log.blockNumber)));
      } catch {
        // Not a CallbackRequested log.
      }
    }
  } catch (cause) {
    // Lasna being unreachable must not take the page down; a loop still shows without its reactive link.
    console.warn("lasna lookup skipped", cause instanceof Error ? cause.message : cause);
  }
}

/** Millisecond timestamp of a Base Sepolia block. Blocks are 200 ms apart; `timestamp` alone is whole seconds. */
async function blockMs(block: number): Promise<number> {
  const known = blockMsCache.get(block);
  if (known !== undefined) return known;
  const result = (await rpc(BASE_SEPOLIA_RPC, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])) as {
    timestamp: string;
    timestampMs?: string;
  } | null;
  if (!result) throw new Error(`Base Sepolia block ${block} not found`);
  const ms = result.timestampMs ? Number(BigInt(result.timestampMs)) : Number(BigInt(result.timestamp)) * 1000;
  blockMsCache.set(block, ms);
  return ms;
}

function decode<TAbi extends typeof vaultAbi | typeof poolAbi | typeof callbackAbi>(abi: TAbi, log: RawLog) {
  try {
    return decodeEventLog({ abi: abi as typeof vaultAbi, data: log.data, topics: log.topics.filter(Boolean) as [Hex, ...Hex[]] });
  } catch {
    return null; // ERC-20 Transfer and other events the app does not show.
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function build(): Promise<History> {
  const logs = [...store.values()].sort(
    (a, b) => Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)) || Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex)),
  );
  const events: HistoryEvent[] = [];
  const settledByTx = new Map<string, bigint>();
  const loops: HistoryLoop[] = [];

  for (const log of logs) {
    const block = Number(BigInt(log.blockNumber));

    if (same(log.address, ADDRESSES.vault)) {
      const decoded = decode(vaultAbi, log);
      if (!decoded) continue;
      const base = { txHash: log.transactionHash, block, atMs: await blockMs(block) };
      if (decoded.eventName === "RedeemQueued") {
        events.push({ kind: "queued", requestId: Number(decoded.args.requestId), account: decoded.args.owner, assets: decoded.args.assets.toString(), ...base });
      } else if (decoded.eventName === "RedeemSettled") {
        events.push({ kind: "settled", requestId: Number(decoded.args.requestId), account: decoded.args.owner, assets: decoded.args.assets.toString(), ...base });
        settledByTx.set(log.transactionHash, (settledByTx.get(log.transactionHash) ?? 0n) + decoded.args.assets);
      } else if (decoded.eventName === "RedeemPaidAtOnce") {
        events.push({ kind: "paid-at-once", requestId: 0, account: decoded.args.receiver, assets: decoded.args.assets.toString(), ...base });
      } else if (decoded.eventName === "ClaimTransferred") {
        events.push({ kind: "transferred", requestId: Number(decoded.args.requestId), account: decoded.args.to, assets: decoded.args.assets.toString(), ...base });
      }
    } else if (same(log.address, ADDRESSES.pool)) {
      const decoded = decode(poolAbi, log) as { eventName: string; args: { requestId: bigint; seller: string; assets: bigint; paid: bigint; fee: bigint } } | null;
      if (!decoded || decoded.eventName !== "ClaimBought") continue;
      events.push({
        kind: "bought",
        requestId: Number(decoded.args.requestId),
        account: decoded.args.seller,
        assets: decoded.args.assets.toString(),
        paid: decoded.args.paid.toString(),
        fee: decoded.args.fee.toString(),
        txHash: log.transactionHash,
        block,
        atMs: await blockMs(block),
      });
    } else if (same(log.address, ADDRESSES.callback)) {
      const decoded = decode(callbackAbi, log) as { eventName: string; args: { originTxHash: bigint; originBlock: bigint; settled: bigint; paidAtMs: bigint } } | null;
      if (!decoded || decoded.eventName !== "LoopClosed") continue;
      const settled = Number(decoded.args.settled);
      if (settled === 0) continue; // A callback that found nothing to pay is not a loop.
      const originBlock = Number(decoded.args.originBlock);
      const originMs = await blockMs(originBlock);
      const paidAtMs = Number(decoded.args.paidAtMs);
      const originTx = `0x${decoded.args.originTxHash.toString(16).padStart(64, "0")}`;
      loops.push({
        id: loops.length + 1,
        originTx,
        originBlock,
        originMs,
        reactiveTx: reactiveByOrigin.get(originTx) ?? null,
        payoutTx: log.transactionHash,
        payoutBlock: block,
        paidAtMs,
        latencyMs: paidAtMs - originMs,
        settled,
        assets: "0",
      });
    }
  }

  // Vault logs sort before the callback's LoopClosed in the same transaction, so totals are complete by now.
  for (const loop of loops) loop.assets = (settledByTx.get(loop.payoutTx) ?? 0n).toString();
  return { events, loops, fetchedAtMs: Date.now() };
}

async function load(): Promise<History> {
  const tail = refreshTail().catch((cause: unknown) => {
    // Without any history yet there is nothing to fall back on, so let the backfill decide whether to fail.
    console.warn("history tail skipped", cause instanceof Error ? cause.message : cause);
  });
  await Promise.all([tail, refreshBackfill(), refreshReactive()]);
  return build();
}

export async function getHistory(): Promise<History> {
  if (cached && Date.now() - cached.at < RESPONSE_CACHE_MS) return cached.value;
  if (!inFlight) {
    inFlight = load()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .catch((cause) => {
        // Serve the last good answer through an outage rather than blanking the page.
        if (cached) return cached.value;
        throw cause;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
