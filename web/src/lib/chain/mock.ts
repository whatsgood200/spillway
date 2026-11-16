import { feeFor, poolFeeBps } from "../fee";
import { USDC } from "../format";
import {
  ChainError,
  type ChainAdapter,
  type Claim,
  type ClaimEvent,
  type LatencyStats,
  type Loop,
  type PoolState,
  type QueueEntry,
  type TxOptions,
  type VaultState,
  type WalletState,
  type WithdrawQuote,
} from "./types";

/**
 * In-browser simulation of the vault, the pool and the reactive loop.
 * It keeps realistic behaviour: latency, wallet rejection, reverts, wrong network and empty data.
 * Nothing here touches a chain. Production builds refuse to start with it (see ./index.ts).
 */

const STORAGE_KEY = "spillway-mock-v1";
const ME = "0x7A3fC2b9E41d08a6B5c0D9e2F1a4B7c8D6e5F301";

interface QueueItem {
  requestId: number;
  assets: bigint;
  queuedAtMs: number;
  heldByPool: boolean;
  mine: boolean;
  paidOut: bigint;
}

interface MockState {
  connected: boolean;
  wrongNetwork: boolean;
  walletUsdc: bigint;
  myVaultBalance: bigint;
  myPoolBalance: bigint;
  vaultLent: bigint;
  vaultIdle: bigint;
  queue: QueueItem[];
  claims: Record<number, Claim>;
  poolIdle: bigint;
  poolFees: bigint;
  loops: Loop[];
  nextFailure: "rejected" | "reverted" | null;
  nextRequestId: number;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function fakeHash(random: () => number): string {
  let hash = "0x";
  for (let i = 0; i < 64; i++) hash += Math.floor(random() * 16).toString(16);
  return hash;
}

function seededState(now: number): MockState {
  const random = seededRandom(20261115);
  const loops: Loop[] = [];
  for (let i = 0; i < 214; i++) {
    // Most loops land between 1.0 and 1.8 s, with a thin tail, in 200 ms block steps.
    const tail = random() < 0.06 ? 600 + Math.floor(random() * 4) * 200 : 0;
    const latencyMs = 1000 + Math.floor(random() * 5) * 200 + tail;
    loops.push({
      id: i + 1,
      atMs: now - (214 - i) * 95_000,
      assets: BigInt(200 + Math.floor(random() * 18) * 100) * USDC,
      latencyMs,
      repayTx: fakeHash(random),
      reactiveTx: fakeHash(random),
      payoutTx: fakeHash(random),
    });
  }
  const amounts = [1200, 1250, 500, 2000, 900, 600];
  const queue: QueueItem[] = amounts.map((amount, index) => ({
    requestId: index + 1,
    assets: BigInt(amount) * USDC,
    queuedAtMs: now - (amounts.length - index) * 140_000,
    heldByPool: index === 1 || index === 3,
    mine: false,
    paidOut: index === 1 ? 1238_750000n : index === 3 ? 1978_000000n : 0n,
  }));
  return {
    connected: false,
    wrongNetwork: false,
    walletUsdc: 2500n * USDC,
    myVaultBalance: 4000n * USDC,
    myPoolBalance: 0n,
    vaultLent: 48_000n * USDC,
    vaultIdle: 0n,
    queue,
    claims: {},
    poolIdle: 12_200n * USDC,
    poolFees: 412_300000n,
    loops,
    nextFailure: null,
    nextRequestId: amounts.length + 1,
  };
}

function emptyState(): MockState {
  return {
    connected: false,
    wrongNetwork: false,
    walletUsdc: 2500n * USDC,
    myVaultBalance: 0n,
    myPoolBalance: 0n,
    vaultLent: 0n,
    vaultIdle: 0n,
    queue: [],
    claims: {},
    poolIdle: 0n,
    poolFees: 0n,
    loops: [],
    nextFailure: null,
    nextRequestId: 1,
  };
}

const serialize = (state: MockState) =>
  JSON.stringify(state, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));
const deserialize = (text: string): MockState =>
  JSON.parse(text, (_key, value) => (typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockAdapter(): ChainAdapter {
  const listeners = new Set<() => void>();
  const random = seededRandom(Date.now() % 4294967296);
  let state: MockState | null = null;

  function load(): MockState {
    if (state) return state;
    try {
      const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      state = saved ? deserialize(saved) : seededState(Date.now());
    } catch {
      state = seededState(Date.now());
    }
    return state;
  }

  function commit() {
    try {
      if (state && typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, serialize(state));
    } catch {
      // Storage can be blocked in private windows; the simulation still works in memory.
    }
    listeners.forEach((listener) => listener());
  }

  const read = async <T>(fn: (s: MockState) => T): Promise<T> => {
    await wait(120 + random() * 220);
    return fn(load());
  };

  const poolClaimsValue = (s: MockState) => s.queue.filter((q) => q.heldByPool).reduce((sum, q) => sum + q.assets, 0n);
  const poolTotal = (s: MockState) => s.poolIdle + poolClaimsValue(s);

  /** Simulates a wallet prompt followed by block inclusion, with the failure modes a real wallet has. */
  async function transact(options: TxOptions | undefined, apply: (s: MockState) => void): Promise<void> {
    const s = load();
    if (!s.connected) throw new ChainError("disconnected", "Connect a wallet first.");
    if (s.wrongNetwork) throw new ChainError("wrong-network", "Your wallet is on another network. Switch to Base Sepolia.");
    options?.onPhase?.("wallet");
    await wait(500 + random() * 400);
    if (s.nextFailure === "rejected") {
      s.nextFailure = null;
      commit();
      throw new ChainError("rejected", "You declined the request in your wallet. Nothing was sent.");
    }
    options?.onPhase?.("pending");
    await wait(700 + random() * 700);
    if (s.nextFailure === "reverted") {
      s.nextFailure = null;
      commit();
      throw new ChainError("reverted", "The transaction reverted on Base Sepolia. Your balances are unchanged.");
    }
    apply(s);
    commit();
  }

  function event(kind: ClaimEvent["kind"], network: ClaimEvent["network"], atMs = Date.now()): ClaimEvent {
    return { kind, network, atMs, txHash: fakeHash(random) };
  }

  /** Pays the queue head first, strictly in order, for as long as idle liquidity covers the next request. */
  function settle(s: MockState, repayEvent: ClaimEvent, latencyMs: number) {
    const repaidAt = repayEvent.atMs ?? Date.now();
    const reactive = event("reactive", "lasna", repaidAt + Math.round(latencyMs * 0.55));
    const paidAt = repaidAt + latencyMs;
    while (s.queue.length > 0 && s.vaultIdle >= s.queue[0].assets) {
      const head = s.queue.shift()!;
      s.vaultIdle -= head.assets;
      const payout = event("paid", "base-sepolia", paidAt);
      if (head.heldByPool) {
        s.poolIdle += head.assets;
        s.poolFees += head.assets - head.paidOut;
      } else if (head.mine) {
        s.walletUsdc += head.assets;
      }
      const claim = s.claims[head.requestId];
      if (claim) {
        claim.events.push(repayEvent, reactive, payout);
        claim.latencyMs = latencyMs;
        if (claim.status === "queued") {
          claim.status = "paid";
          claim.received = head.assets;
          claim.fee = 0n;
        }
        claim.position = null;
        claim.aheadAssets = 0n;
      }
      s.loops.push({
        id: s.loops.length + 1,
        atMs: paidAt,
        assets: head.assets,
        latencyMs,
        repayTx: repayEvent.txHash,
        reactiveTx: reactive.txHash,
        payoutTx: payout.txHash,
      });
    }
  }

  function requireConnected(s: MockState) {
    if (!s.connected) throw new ChainError("disconnected", "Connect a wallet first.");
  }

  return {
    isMock: true,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getWallet: () =>
      read<WalletState>((s) => {
        if (!s.connected) return { status: "disconnected" };
        if (s.wrongNetwork) return { status: "wrong-network", address: ME };
        return { status: "connected", address: ME, usdc: s.walletUsdc, vaultBalance: s.myVaultBalance, poolBalance: s.myPoolBalance };
      }),

    async connect() {
      await wait(400);
      load().connected = true;
      commit();
    },

    async disconnect() {
      load().connected = false;
      commit();
    },

    async switchNetwork() {
      await wait(500);
      load().wrongNetwork = false;
      commit();
    },

    getVaultState: () =>
      read<VaultState>((s) => {
        const total = s.vaultLent + s.vaultIdle;
        return {
          totalAssets: total,
          lentOut: s.vaultLent,
          withdrawable: s.vaultIdle,
          utilizationBps: total === 0n ? 0 : Number((s.vaultLent * 10_000n) / total),
          queueLength: s.queue.length,
          queuedAssets: s.queue.reduce((sum, q) => sum + q.assets, 0n),
        };
      }),

    getQueue: () =>
      read<QueueEntry[]>((s) =>
        s.queue.map((q, index) => ({
          requestId: q.requestId,
          position: index + 1,
          assets: q.assets,
          queuedAtMs: q.queuedAtMs,
          heldByPool: q.heldByPool,
          mine: q.mine,
        })),
      ),

    getPoolState: () =>
      read<PoolState>((s) => {
        const total = poolTotal(s);
        return {
          totalAssets: total,
          idle: s.poolIdle,
          claimsHeld: s.queue.filter((q) => q.heldByPool).length,
          claimsValue: poolClaimsValue(s),
          depthBps: total === 0n ? 0 : Number((s.poolIdle * 10_000n) / total),
          feeBpsNow: poolFeeBps(s.poolIdle, total),
          feesEarned: s.poolFees,
        };
      }),

    quoteWithdraw: (assets) =>
      read<WithdrawQuote>((s) => {
        const aheadAssets = s.queue.reduce((sum, q) => sum + q.assets, 0n);
        const total = poolTotal(s);
        const feeBps = poolFeeBps(s.poolIdle - assets, total);
        const fee = feeFor(assets, feeBps);
        const receive = assets - fee;
        return {
          assets,
          paidAtOnce: s.queue.length === 0 && s.vaultIdle >= assets,
          position: s.queue.length + 1,
          aheadAssets,
          cashNow:
            s.poolIdle >= receive
              ? { available: true, receive, fee, feeBps }
              : { available: false, reason: "The pool does not hold enough cash for this amount right now. Try a smaller amount or wait in line." },
        };
      }),

    getClaim: (requestId) =>
      read<Claim | null>((s) => {
        const claim = s.claims[requestId];
        if (!claim) return null;
        const index = s.queue.findIndex((q) => q.requestId === requestId);
        return {
          ...claim,
          position: index >= 0 && claim.status === "queued" ? index + 1 : null,
          aheadAssets: index >= 0 ? s.queue.slice(0, index).reduce((sum, q) => sum + q.assets, 0n) : 0n,
        };
      }),

    getMyClaims: () => read<Claim[]>((s) => Object.values(s.claims).sort((a, b) => b.requestId - a.requestId)),

    getLoops: (limit) => read<Loop[]>((s) => s.loops.slice(-limit).reverse()),

    getLatencyStats: () =>
      read<LatencyStats>((s) => {
        const sorted = s.loops.map((l) => l.latencyMs).sort((a, b) => a - b);
        const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
        const buckets = new Map<number, number>();
        for (const latency of sorted) {
          const from = Math.floor(latency / 200) * 200;
          buckets.set(from, (buckets.get(from) ?? 0) + 1);
        }
        return {
          count: sorted.length,
          p50: at(0.5),
          p90: at(0.9),
          p99: at(0.99),
          min: sorted[0] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
          histogram: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([fromMs, count]) => ({ fromMs, count })),
          race: sorted.length
            ? [
                { delaySeconds: 1, toQueueBps: 3100 },
                { delaySeconds: 2, toQueueBps: 9400 },
                { delaySeconds: 3, toQueueBps: 9900 },
                { delaySeconds: 5, toQueueBps: 10_000 },
                { delaySeconds: 7, toQueueBps: 10_000 },
              ]
            : [],
        };
      }),

    deposit: (assets, options) =>
      transact(options, (s) => {
        if (s.walletUsdc < assets) throw new ChainError("insufficient", "Your wallet does not hold that much USDC.");
        s.walletUsdc -= assets;
        s.myVaultBalance += assets;
        s.vaultIdle += assets;
      }),

    async requestRedeem(assets, options) {
      let result: { requestId: number | null; paidAtOnce: boolean } = { requestId: null, paidAtOnce: false };
      await transact(options, (s) => {
        if (s.myVaultBalance < assets) throw new ChainError("insufficient", "You have less than that in the vault.");
        s.myVaultBalance -= assets;
        const requestId = s.nextRequestId++;
        const paidAtOnce = s.queue.length === 0 && s.vaultIdle >= assets;
        const queued = event("queued", "base-sepolia");
        const claim: Claim = {
          requestId,
          requester: null,
          assets,
          status: paidAtOnce ? "paid" : "queued",
          position: null,
          aheadAssets: 0n,
          received: paidAtOnce ? assets : null,
          fee: paidAtOnce ? 0n : null,
          latencyMs: null,
          events: paidAtOnce ? [{ ...queued, kind: "paid" }] : [queued],
        };
        s.claims[requestId] = claim;
        if (paidAtOnce) {
          s.vaultIdle -= assets;
          s.walletUsdc += assets;
        } else {
          s.queue.push({ requestId, assets, queuedAtMs: queued.atMs ?? Date.now(), heldByPool: false, mine: true, paidOut: 0n });
        }
        result = { requestId, paidAtOnce };
      });
      return result;
    },

    async cashOut(assets, options) {
      const { requestId, paidAtOnce } = await this.requestRedeem(assets, options);
      if (paidAtOnce || requestId === null) return { requestId: null, received: assets, paidAtOnce: true };
      const { received } = await this.sellClaim(requestId, options);
      return { requestId, received, paidAtOnce: false };
    },

    async sellClaim(requestId, options) {
      let received = 0n;
      await transact(options, (s) => {
        const item = s.queue.find((q) => q.requestId === requestId && q.mine && !q.heldByPool);
        const claim = s.claims[requestId];
        if (!item || !claim) throw new ChainError("unavailable", "This place in the queue is no longer yours to sell.");
        const feeBps = poolFeeBps(s.poolIdle - item.assets, poolTotal(s));
        const fee = feeFor(item.assets, feeBps);
        received = item.assets - fee;
        if (s.poolIdle < received) throw new ChainError("unavailable", "The pool ran out of cash before your sale confirmed.");
        s.poolIdle -= received;
        s.walletUsdc += received;
        item.heldByPool = true;
        item.mine = false;
        item.paidOut = received;
        claim.status = "sold";
        claim.received = received;
        claim.fee = fee;
        claim.events.push(event("sold", "base-sepolia"));
      });
      return { received };
    },

    poolDeposit: (assets, options) =>
      transact(options, (s) => {
        if (s.walletUsdc < assets) throw new ChainError("insufficient", "Your wallet does not hold that much USDC.");
        s.walletUsdc -= assets;
        s.myPoolBalance += assets;
        s.poolIdle += assets;
      }),

    poolWithdraw: (assets, options) =>
      transact(options, (s) => {
        if (s.myPoolBalance < assets) throw new ChainError("insufficient", "You have less than that in the pool.");
        if (s.poolIdle < assets) throw new ChainError("unavailable", "The pool's cash is tied up in queue places. It frees up as they are paid.");
        s.myPoolBalance -= assets;
        s.poolIdle -= assets;
        s.walletUsdc += assets;
      }),

    async demoQueueWithdrawal(assets) {
      const s = load();
      requireConnected(s);
      await wait(900 + random() * 500);
      // The demo lender's deposit is lent straight back out, so the request has to queue.
      s.vaultLent += assets;
      const requestId = s.nextRequestId++;
      s.queue.push({ requestId, assets, queuedAtMs: Date.now(), heldByPool: false, mine: false, paidOut: 0n });
      commit();
      return { requestId };
    },

    async demoRepay(assets) {
      const s = load();
      requireConnected(s);
      await wait(600 + random() * 400);
      const repaid = assets > s.vaultLent ? s.vaultLent : assets;
      if (repaid === 0n) throw new ChainError("unavailable", "The demo borrower has nothing left to repay.");
      s.vaultLent -= repaid;
      s.vaultIdle += repaid;
      const repayEvent = event("liquidity", "base-sepolia");
      commit();
      // The reactive loop: Lasna block, then callback inclusion on Base Sepolia, in 200 ms steps.
      const latencyMs = 1000 + Math.floor(random() * 5) * 200;
      await wait(latencyMs);
      settle(s, repayEvent, latencyMs);
      commit();
    },

    async demoBorrowIdle() {
      const s = load();
      requireConnected(s);
      await wait(600);
      s.vaultLent += s.vaultIdle;
      s.vaultIdle = 0n;
      commit();
    },

    async demoSetNextFailure(failure) {
      load().nextFailure = failure;
      commit();
    },

    async demoSetWrongNetwork(wrong) {
      load().wrongNetwork = wrong;
      commit();
    },

    async demoReset(mode) {
      state = mode === "seeded" ? seededState(Date.now()) : emptyState();
      commit();
    },
  };
}
