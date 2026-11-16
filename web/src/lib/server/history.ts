import "server-only";
import { createPublicClient, decodeEventLog, http, parseAbiItem, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { ADDRESSES, BASE_SEPOLIA_RPC, LASNA_DEPLOY_BLOCK, LASNA_RPC, callbackAbi, poolAbi, reactorAbi, vaultAbi } from "../chain/config";

/**
 * History for the app, read from the contracts' own storage. There is no indexer and no third-party API:
 * the vault keeps every request, the pool keeps every sale and the callback contract keeps every loop.
 *
 * Transaction hashes are not in storage; they are found by asking for the logs of the single block each record
 * names, and cached.
 * Amounts are decimal strings because JSON has no bigint.
 */

export interface HistorySale {
  seller: string;
  paid: string;
  fee: string;
  atMs: number;
  atBlock: number;
}

export interface HistoryRequest {
  id: number;
  owner: string;
  requester: string;
  assets: string;
  queuedAtMs: number;
  queuedBlock: number;
  settledAtMs: number | null;
  settledBlock: number | null;
  sale: HistorySale | null;
}

export interface HistoryLoop {
  id: number;
  originTx: string;
  originBlock: number;
  originMs: number;
  reactiveTx: string | null;
  /** Looked up for the most recent loops only; older rows link by block. */
  payoutTx: string | null;
  payoutBlock: number;
  paidAtMs: number;
  latencyMs: number;
  settled: number;
  assets: string;
}

export interface History {
  requests: HistoryRequest[];
  loops: HistoryLoop[];
  fetchedAtMs: number;
}

export interface ClaimDetail {
  request: HistoryRequest | null;
  queuedTx: string | null;
  soldTx: string | null;
  settledTx: string | null;
  loop: HistoryLoop | null;
}

const RESPONSE_CACHE_MS = 2_500;
const BASE_BLOCK_MS = 200;
const LASNA_EVERY_MS = 5_000;
const PAGE = 100n;
const RECENT_LOOPS_WITH_TX = 25;

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(BASE_SEPOLIA_RPC, { batch: { batchSize: 25, wait: 20 }, timeout: 20_000 }),
  batch: { multicall: true },
});

const queuedEvent = parseAbiItem("event RedeemQueued(uint256 indexed requestId, address indexed owner, uint256 assets)");
const settledEvent = parseAbiItem("event RedeemSettled(uint256 indexed requestId, address indexed owner, uint256 assets)");
const boughtEvent = parseAbiItem("event ClaimBought(uint256 indexed requestId, address indexed seller, uint256 assets, uint256 paid, uint256 fee)");
const loopClosedEvent = parseAbiItem("event LoopClosed(uint256 indexed originTxHash, uint256 originBlock, uint256 settled, uint256 paidAtMs, bool more)");

/** Records that can no longer change are kept; only open requests and new loops are re-read. */
const finalRequests = new Map<number, HistoryRequest>();
const loopStore: HistoryLoop[] = [];
const txCache = new Map<string, string | null>();
const reactiveByOrigin = new Map<string, string>();
let lasnaNotBefore = 0;
let lasnaScannedTo = LASNA_DEPLOY_BLOCK;
let cached: { at: number; value: History } | null = null;
let inFlight: Promise<History> | null = null;

/** The transaction that emitted one specific event, found by reading the logs of the single block it is in. */
async function txOf(key: string, lookup: () => Promise<readonly { transactionHash: Hex | null }[]>): Promise<string | null> {
  if (txCache.has(key)) return txCache.get(key) ?? null;
  try {
    const logs = await lookup();
    const hash = logs[0]?.transactionHash ?? null;
    if (hash) txCache.set(key, hash); // A miss is not cached: the node may simply be a block behind.
    return hash;
  } catch (cause) {
    console.warn("transaction lookup skipped", key, cause instanceof Error ? cause.message : cause);
    return null;
  }
}

const queuedTx = (request: HistoryRequest) =>
  txOf(`queued:${request.id}`, () =>
    client.getLogs({ address: ADDRESSES.vault, event: queuedEvent, args: { requestId: BigInt(request.id) }, fromBlock: BigInt(request.queuedBlock), toBlock: BigInt(request.queuedBlock) }),
  );

const settledTx = (request: HistoryRequest) =>
  request.settledBlock === null
    ? Promise.resolve(null)
    : txOf(`settled:${request.id}`, () =>
        client.getLogs({ address: ADDRESSES.vault, event: settledEvent, args: { requestId: BigInt(request.id) }, fromBlock: BigInt(request.settledBlock!), toBlock: BigInt(request.settledBlock!) }),
      );

const soldTx = (request: HistoryRequest) =>
  request.sale === null
    ? Promise.resolve(null)
    : txOf(`sold:${request.id}`, () =>
        client.getLogs({ address: ADDRESSES.pool, event: boughtEvent, args: { requestId: BigInt(request.id) }, fromBlock: BigInt(request.sale!.atBlock), toBlock: BigInt(request.sale!.atBlock) }),
      );

const payoutTx = (loop: HistoryLoop) =>
  txOf(`loop:${loop.id}`, () =>
    client.getLogs({ address: ADDRESSES.callback, event: loopClosedEvent, args: { originTxHash: BigInt(loop.originTx) }, fromBlock: BigInt(loop.payoutBlock), toBlock: BigInt(loop.payoutBlock) }),
  );

async function refreshRequests(): Promise<HistoryRequest[]> {
  const next = Number(await client.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "nextRequestId" }));
  let firstOpen = 1;
  while (finalRequests.has(firstOpen)) firstOpen++;

  const open: HistoryRequest[] = [];
  for (let from = firstOpen; from < next; from += Number(PAGE)) {
    const page = await client.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "requestsSlice", args: [BigInt(from), PAGE] });
    const sales = await Promise.all(
      page.map((_, index) => client.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "sales", args: [BigInt(from + index)] })),
    );
    page.forEach((raw, index) => {
      const [seller, , paid, fee, atMs, atBlock] = sales[index];
      const request: HistoryRequest = {
        id: from + index,
        owner: raw.owner,
        requester: raw.requester,
        assets: raw.assets.toString(),
        queuedAtMs: Number(raw.queuedAtMs),
        queuedBlock: Number(raw.queuedBlock),
        settledAtMs: raw.settledAtMs === 0n ? null : Number(raw.settledAtMs),
        settledBlock: raw.settledBlock === 0n ? null : Number(raw.settledBlock),
        sale: atBlock === 0n ? null : { seller, paid: paid.toString(), fee: fee.toString(), atMs: Number(atMs), atBlock: Number(atBlock) },
      };
      // Once paid, a request and its sale record never change again.
      if (request.settledAtMs !== null) finalRequests.set(request.id, request);
      else open.push(request);
    });
  }
  return [...finalRequests.values(), ...open].sort((a, b) => a.id - b.id);
}

/** Reactive transactions on Lasna, matched to loops by the origin transaction hash they carry. */
async function refreshReactive() {
  if (Date.now() < lasnaNotBefore) return;
  lasnaNotBefore = Date.now() + LASNA_EVERY_MS;
  try {
    const response = await fetch(LASNA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ address: ADDRESSES.reactor, fromBlock: `0x${lasnaScannedTo.toString(16)}`, toBlock: "latest" }],
      }),
    });
    const body = (await response.json()) as { result?: { data: Hex; topics: Hex[]; transactionHash: string; blockNumber: Hex }[] };
    for (const log of body.result ?? []) {
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

async function refreshLoops(): Promise<HistoryLoop[]> {
  const count = Number(await client.readContract({ address: ADDRESSES.callback, abi: callbackAbi, functionName: "loopCount" }));
  while (loopStore.length < count) {
    const offset = loopStore.length;
    const page = await client.readContract({ address: ADDRESSES.callback, abi: callbackAbi, functionName: "loopsSlice", args: [BigInt(offset), PAGE] });
    if (page.length === 0) break;
    page.forEach((raw, index) => {
      const paidAtMs = Number(raw.paidAtMs);
      // Base Sepolia makes exactly one block every 200 ms, so the repayment block's time follows from the payout
      // time and the block gap. Checked against each block's own timestampMs for all 204 loops measured on
      // 2026-11-16 (measurements/latency-2026-11-16.json): no difference. This saves one RPC call per loop.
      const originMs = paidAtMs - (Number(raw.payoutBlock) - Number(raw.originBlock)) * BASE_BLOCK_MS;
      loopStore.push({
        id: offset + index + 1,
        originTx: `0x${raw.originTxHash.toString(16).padStart(64, "0")}`,
        originBlock: Number(raw.originBlock),
        originMs,
        reactiveTx: null,
        payoutTx: null,
        payoutBlock: Number(raw.payoutBlock),
        paidAtMs,
        latencyMs: paidAtMs - originMs,
        settled: raw.settled,
        assets: raw.assets.toString(),
      });
    });
  }
  // Transaction links are filled in the background: the numbers come from storage and must not wait on log lookups.
  void fillPayoutTx();
  for (const loop of loopStore) loop.reactiveTx ??= reactiveByOrigin.get(loop.originTx) ?? null;
  return loopStore.map((loop) => ({ ...loop }));
}

let fillingPayouts = false;
async function fillPayoutTx() {
  if (fillingPayouts) return;
  fillingPayouts = true;
  try {
    for (const loop of loopStore.slice(-RECENT_LOOPS_WITH_TX)) {
      if (!loop.payoutTx) loop.payoutTx = await payoutTx(loop);
    }
  } finally {
    fillingPayouts = false;
  }
}

async function load(): Promise<History> {
  // The Lasna scan only adds links to reactive transactions; it runs alongside and is picked up on the next read.
  void refreshReactive();
  const requests = await refreshRequests();
  const loops = await refreshLoops();
  return { requests, loops, fetchedAtMs: Date.now() };
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
        // Serve the last good answer through an RPC hiccup rather than blanking the page.
        if (cached) return cached.value;
        throw cause;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Everything the claim page shows for one request, including the transactions behind each step. */
export async function getClaimDetail(id: number): Promise<ClaimDetail> {
  const history = await getHistory();
  const request = history.requests.find((candidate) => candidate.id === id) ?? null;
  if (!request) return { request: null, queuedTx: null, soldTx: null, settledTx: null, loop: null };
  const loop = request.settledBlock === null ? null : (history.loops.find((candidate) => candidate.payoutBlock === request.settledBlock) ?? null);
  const [queued, sold, settled] = await Promise.all([queuedTx(request), soldTx(request), settledTx(request)]);
  if (loop && !loop.payoutTx) loop.payoutTx = settled;
  return { request, queuedTx: queued, soldTx: sold, settledTx: settled, loop };
}
