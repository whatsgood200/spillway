import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  maxUint256,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import type { ClaimDetail, History, HistoryRequest } from "../server/history";
import race from "../../data/race.json";
import { ADDRESSES, BASE_SEPOLIA_ID, BASE_SEPOLIA_RPC, erc20Abi, poolAbi, vaultAbi } from "./config";
import {
  CashNow,
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
 * The live adapter. State is read from Base Sepolia over the public RPC, history from this app's own
 * /api/history route, and transactions are signed by the visitor's browser wallet.
 * Screens only ever see confirmed state: every write waits for its receipt before resolving.
 */

type Address = `0x${string}`;
const SLIPPAGE_BPS = 50n; // The pool's fee can move between quote and inclusion; accept up to 0.5 percent less.
const POLL_MS = 4_000;

function provider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

function requireProvider(): EIP1193Provider {
  const found = provider();
  if (!found) throw new ChainError("disconnected", "No browser wallet found. Install MetaMask or another wallet, or use the demo console, which needs no wallet.");
  return found;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function explain(cause: unknown): ChainError {
  if (cause instanceof ChainError) return cause;
  if (cause instanceof BaseError) {
    if (cause.walk((error) => error instanceof UserRejectedRequestError)) {
      return new ChainError("rejected", "You declined the request in your wallet. Nothing was sent.");
    }
    const revert = cause.walk((error) => error instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) {
      const name = revert.data?.errorName;
      if (name === "NotEnoughCash") return new ChainError("unavailable", "The pool does not hold enough cash for this amount right now. Try a smaller amount or wait in line.");
      if (name === "ReceiveBelowMinimum") return new ChainError("reverted", "The pool's price moved while your transaction was pending. Nothing was taken; check the new price and try again.");
      if (name === "RequestTooSmall") return new ChainError("reverted", "The smallest withdrawal is 1 USDC.");
      return new ChainError("reverted", `The transaction would revert${name ? ` (${name})` : ""}. Your balances are unchanged.`);
    }
    return new ChainError("reverted", cause.shortMessage || "The network rejected the transaction. Your balances are unchanged.");
  }
  return new ChainError("unavailable", cause instanceof Error ? cause.message : "Something went wrong talking to the network.");
}

export function createRealAdapter(): ChainAdapter {
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC), batch: { multicall: true } });
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let polling: ReturnType<typeof setInterval> | null = null;
  let history: { at: number; promise: Promise<History> } | null = null;

  function startWatching() {
    if (polling || typeof window === "undefined") return;
    polling = setInterval(notify, POLL_MS);
    const wallet = provider() as (EIP1193Provider & { on?: (event: string, handler: () => void) => void }) | null;
    wallet?.on?.("accountsChanged", notify);
    wallet?.on?.("chainChanged", notify);
  }

  /** One history request serves every panel on the page for a few seconds. */
  function getHistory(): Promise<History> {
    if (history && Date.now() - history.at < 3_000) return history.promise;
    const promise = fetch("/api/history")
      .then(async (response) => {
        const body = (await response.json()) as { data: History | null; error: string | null };
        if (!response.ok || !body.data) throw new ChainError("unavailable", body.error ?? "Could not read the event history.");
        return body.data;
      })
      .catch((cause) => {
        history = null;
        throw cause;
      });
    history = { at: Date.now(), promise };
    return promise;
  }

  async function account(): Promise<Address | null> {
    const wallet = provider();
    if (!wallet) return null;
    const accounts = (await wallet.request({ method: "eth_accounts" })) as Address[];
    return accounts[0] ?? null;
  }

  async function signer(): Promise<{ address: Address; write: ReturnType<typeof createWalletClient> }> {
    const wallet = requireProvider();
    const address = await account();
    if (!address) throw new ChainError("disconnected", "Connect a wallet first.");
    const chainId = Number(BigInt((await wallet.request({ method: "eth_chainId" })) as string));
    if (chainId !== BASE_SEPOLIA_ID) throw new ChainError("wrong-network", "Your wallet is on another network. Switch to Base Sepolia.");
    return { address, write: createWalletClient({ account: address, chain: baseSepolia, transport: custom(wallet) }) };
  }

  /** Sends one transaction and waits for it to be included. Returns its logs for the caller to read. */
  async function send(
    options: TxOptions | undefined,
    request: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] },
  ): Promise<{ address: string; data: Hex; topics: Hex[] }[]> {
    try {
      const { address, write } = await signer();
      // Simulate first so a doomed transaction is refused before the wallet opens.
      await publicClient.simulateContract({ ...request, account: address } as never);
      // Headroom over the estimate: a node a block behind can estimate too low for the path the transaction takes.
      const estimate = await publicClient.estimateContractGas({ ...request, account: address } as never);
      options?.onPhase?.("wallet");
      const hash = await write.writeContract({ ...request, account: address, chain: baseSepolia, gas: (estimate * 3n) / 2n + 60_000n } as never);
      options?.onPhase?.("pending");
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== "success") throw new ChainError("reverted", "The transaction reverted on Base Sepolia. Your balances are unchanged.");
      history = null;
      return receipt.logs as unknown as { address: string; data: Hex; topics: Hex[] }[];
    } catch (cause) {
      throw explain(cause);
    }
  }

  async function approveIfNeeded(options: TxOptions | undefined, token: Address, spender: Address, needed: bigint) {
    const owner = await account();
    if (!owner) throw new ChainError("disconnected", "Connect a wallet first.");
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (allowance < needed) await send(options, { address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
  }

  /** Shares to burn for `assets`. Asking for the whole balance burns every share, so no dust is left behind. */
  async function sharesFor(assets: bigint, owner: Address): Promise<bigint> {
    const balance = await publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
    const worth = await publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "convertToAssets", args: [balance] });
    if (assets > worth) throw new ChainError("insufficient", "You have less than that in the vault.");
    if (assets === worth) return balance;
    return publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "convertToShares", args: [assets] });
  }

  function findEvent<T extends string>(logs: { address: string; data: Hex; topics: Hex[] }[], contract: Address, abi: typeof vaultAbi | typeof poolAbi, name: T) {
    for (const log of logs) {
      if (!same(log.address, contract)) continue;
      try {
        const decoded = decodeEventLog({ abi: abi as typeof vaultAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (decoded.eventName === name) return decoded.args as Record<string, unknown>;
      } catch {
        // Some other event.
      }
    }
    return null;
  }

  async function readQueue(): Promise<{ ids: readonly bigint[]; owners: readonly Address[]; amounts: readonly bigint[] }> {
    const [ids, owners, amounts] = await publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "queueSlice", args: [0n, 100n] });
    return { ids, owners, amounts };
  }

  /** A claim from the contract's stored record. Transaction hashes come with the detail lookup, when asked for. */
  function buildClaim(
    request: HistoryRequest,
    queue: { ids: readonly bigint[]; amounts: readonly bigint[] },
    detail?: ClaimDetail,
  ): Claim {
    const sale = request.sale;
    const loop = detail?.loop ?? null;
    const timeline: ClaimEvent[] = [{ kind: "queued", atMs: request.queuedAtMs, txHash: detail?.queuedTx ?? "", network: "base-sepolia" }];
    if (sale) timeline.push({ kind: "sold", atMs: sale.atMs, txHash: detail?.soldTx ?? "", network: "base-sepolia" });
    if (request.settledAtMs !== null) {
      if (loop) {
        timeline.push({ kind: "liquidity", atMs: loop.originMs, txHash: loop.originTx, network: "base-sepolia" });
        if (loop.reactiveTx) timeline.push({ kind: "reactive", atMs: null, txHash: loop.reactiveTx, network: "lasna" });
      }
      timeline.push({ kind: "paid", atMs: request.settledAtMs, txHash: detail?.settledTx ?? "", network: "base-sepolia" });
    }

    const index = queue.ids.findIndex((id) => Number(id) === request.id);
    const assets = BigInt(request.assets);
    const settled = request.settledAtMs !== null;
    return {
      requestId: request.id,
      // A one-step cash out has the pool file the request; the person who left is the seller.
      requester: sale && same(request.requester, ADDRESSES.pool) ? sale.seller : request.requester,
      assets,
      status: sale ? "sold" : settled ? "paid" : "queued",
      position: index >= 0 && !sale ? index + 1 : null,
      aheadAssets: index >= 0 ? queue.amounts.slice(0, index).reduce((sum, amount) => sum + amount, 0n) : 0n,
      received: sale ? BigInt(sale.paid) : settled ? assets : null,
      fee: sale ? BigInt(sale.fee) : settled ? 0n : null,
      paidSoFar: BigInt(request.paid),
      // Paid by Reactive when a loop record matches; paid by a direct settle call otherwise.
      latencyMs: loop?.latencyMs ?? null,
      events: timeline,
    };
  }

  async function demo(action: "queue" | "repay" | "borrow", amount?: bigint): Promise<Record<string, unknown>> {
    const response = await fetch("/api/demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, amount: amount?.toString() }),
    });
    const body = (await response.json()) as { data: Record<string, unknown> | null; error: string | null };
    if (!response.ok || !body.data) throw new ChainError("unavailable", body.error ?? "The demo account could not do that.");
    history = null;
    notify();
    return body.data;
  }

  const simulationOnly = async (): Promise<never> => {
    throw new ChainError("unavailable", "This control only exists in the simulation.");
  };

  return {
    isMock: false,

    subscribe(listener) {
      listeners.add(listener);
      startWatching();
      return () => listeners.delete(listener);
    },

    async getWallet(): Promise<WalletState> {
      const wallet = provider();
      const address = await account();
      if (!wallet || !address) return { status: "disconnected" };
      const chainId = Number(BigInt((await wallet.request({ method: "eth_chainId" })) as string));
      if (chainId !== BASE_SEPOLIA_ID) return { status: "wrong-network", address };
      const [usdc, vaultShares, poolShares] = await Promise.all([
        publicClient.readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "balanceOf", args: [address] }),
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "balanceOf", args: [address] }),
      ]);
      const [vaultBalance, poolBalance, unlocksAt] = await Promise.all([
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "convertToAssets", args: [vaultShares] }),
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "convertToAssets", args: [poolShares] }),
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "unlocksAt", args: [address] }),
      ]);
      return { status: "connected", address, usdc, vaultBalance, poolBalance, poolUnlocksAtMs: Number(unlocksAt) * 1000 };
    },

    async connect() {
      try {
        await requireProvider().request({ method: "eth_requestAccounts" });
        notify();
      } catch (cause) {
        throw explain(cause);
      }
    },

    async disconnect() {
      // Browser wallets do not let a site disconnect itself; the visitor does that from the wallet.
      throw new ChainError("unavailable", "Disconnect from inside your wallet.");
    },

    async switchNetwork() {
      const wallet = requireProvider();
      const chainId = `0x${BASE_SEPOLIA_ID.toString(16)}` as const;
      try {
        await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
      } catch {
        try {
          await wallet.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId,
                chainName: "Base Sepolia",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: [BASE_SEPOLIA_RPC],
                blockExplorerUrls: ["https://sepolia.basescan.org"],
              },
            ],
          });
        } catch (cause) {
          throw explain(cause);
        }
      }
      notify();
    },

    async getVaultState(): Promise<VaultState> {
      const [supplied, withdrawable, queueLength, queuedAssets] = await Promise.all([
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "suppliedAssets" }),
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "withdrawable" }),
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "queueLength" }),
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "queuedAssets" }),
      ]);
      const lentOut = supplied - withdrawable;
      return {
        totalAssets: supplied,
        lentOut,
        withdrawable,
        utilizationBps: supplied === 0n ? 0 : Number((lentOut * 10_000n) / supplied),
        queueLength: Number(queueLength),
        queuedAssets,
      };
    },

    async getQueue(): Promise<QueueEntry[]> {
      const [queue, me, past] = await Promise.all([readQueue(), account(), getHistory().catch(() => null)]);
      return queue.ids.map((id, index) => {
        const requestId = Number(id);
        const record = past?.requests.find((request) => request.id === requestId);
        return {
          requestId,
          position: index + 1,
          assets: queue.amounts[index],
          queuedAtMs: record?.queuedAtMs ?? Date.now(),
          heldByPool: same(queue.owners[index], ADDRESSES.pool),
          mine: me !== null && same(queue.owners[index], me),
        };
      });
    },

    async getPoolState(): Promise<PoolState> {
      const [totalAssets, idle, claimsValue, feeBpsNow, queue, feesEarned] = await Promise.all([
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "totalAssets" }),
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "idle" }),
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "pendingAssets", args: [ADDRESSES.pool] }),
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "quote", args: [1_000_000n] }).then(([, , bps]) => bps),
        readQueue(),
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "feesCharged" }),
      ]);
      return {
        totalAssets,
        idle,
        claimsHeld: queue.owners.filter((owner) => same(owner, ADDRESSES.pool)).length,
        claimsValue,
        depthBps: totalAssets === 0n ? 0 : Number((idle * 10_000n) / totalAssets),
        feeBpsNow: Number(feeBpsNow),
        feesEarned,
      };
    },

    async quoteWithdraw(assets): Promise<WithdrawQuote> {
      const [queueLength, queuedAssets, withdrawable, quote] = await Promise.all([
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "queueLength" }),
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "queuedAssets" }),
        publicClient.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "withdrawable" }),
        publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "quote", args: [assets] }),
      ]);
      const [receive, fee, bps, available] = quote;
      return {
        assets,
        paidAtOnce: queueLength === 0n && withdrawable >= assets,
        position: Number(queueLength) + 1,
        aheadAssets: queuedAssets,
        cashNow: available
          ? { available: true, receive, fee, feeBps: Number(bps) }
          : { available: false, reason: "The pool does not hold enough cash for this amount right now. Try a smaller amount or wait in line." },
      };
    },

    async quoteSell(requestId): Promise<CashNow> {
      const [receive, fee, bps, available] = await publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "quoteClaim", args: [BigInt(requestId)] });
      return available ? { available: true, receive, fee, feeBps: Number(bps) } : { available: false, reason: "The pool does not hold enough cash to buy this place right now. Keep waiting, or try again later." };
    },

    async getClaim(requestId) {
      const [response, queue] = await Promise.all([fetch(`/api/claim?id=${requestId}`), readQueue()]);
      const body = (await response.json()) as { data: ClaimDetail | null; error: string | null };
      if (!response.ok || !body.data) throw new ChainError("unavailable", body.error ?? "Could not read this request.");
      return body.data.request ? buildClaim(body.data.request, queue, body.data) : null;
    },

    async getMyClaims() {
      const me = await account();
      if (!me) return [];
      const [past, queue] = await Promise.all([getHistory(), readQueue()]);
      // Yours if you asked for it, it pays you, or you sold it to the pool.
      return past.requests
        .filter((request) => same(request.requester, me) || same(request.owner, me) || (request.sale !== null && same(request.sale.seller, me)))
        .sort((a, b) => b.id - a.id)
        .map((request) => buildClaim(request, queue));
    },

    async getLoops(limit): Promise<Loop[]> {
      const past = await getHistory();
      return past.loops
        .slice(-limit)
        .reverse()
        .map((loop) => ({
          id: loop.id,
          atMs: loop.paidAtMs,
          assets: BigInt(loop.assets),
          latencyMs: loop.latencyMs,
          repayTx: loop.originTx,
          reactiveTx: loop.reactiveTx,
          payoutTx: loop.payoutTx,
        }));
    },

    async getLatencyStats(): Promise<LatencyStats> {
      const past = await getHistory();
      const sorted = past.loops.map((loop) => loop.latencyMs).sort((a, b) => a - b);
      const at = (quantile: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] : 0);
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
        // Recorded by scripts/race.mjs and summarised by scripts/race-report.mjs; each trial is on chain.
        race: race.rows,
        raceSource: race.rows.length ? `${race.trials} trials on Base Sepolia on the earlier contracts (v2), ${race.source}` : null,
      };
    },

    async deposit(assets, options) {
      const { address } = await signer().catch((cause) => {
        throw explain(cause);
      });
      await approveIfNeeded(options, ADDRESSES.usdc, ADDRESSES.vault, assets);
      await send(options, { address: ADDRESSES.vault, abi: vaultAbi, functionName: "deposit", args: [assets, address] });
      notify();
    },

    async requestRedeem(assets, options) {
      const { address } = await signer().catch((cause) => {
        throw explain(cause);
      });
      const shares = await sharesFor(assets, address);
      const logs = await send(options, { address: ADDRESSES.vault, abi: vaultAbi, functionName: "requestRedeem", args: [shares, address] });
      notify();
      const queued = findEvent(logs, ADDRESSES.vault, vaultAbi, "RedeemQueued");
      return queued ? { requestId: Number(queued.requestId), paidAtOnce: false } : { requestId: null, paidAtOnce: true };
    },

    async cashOut(assets, options) {
      const { address } = await signer().catch((cause) => {
        throw explain(cause);
      });
      const shares = await sharesFor(assets, address);
      const [quoted] = await publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "quote", args: [assets] });
      const minReceive = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      await approveIfNeeded(options, ADDRESSES.vault, ADDRESSES.pool, shares);
      const logs = await send(options, { address: ADDRESSES.pool, abi: poolAbi, functionName: "cashOut", args: [shares, minReceive, address] });
      notify();
      const bought = findEvent(logs, ADDRESSES.pool, poolAbi, "ClaimBought");
      if (bought) return { requestId: Number(bought.requestId), received: bought.paid as bigint, paidAtOnce: false };
      const passed = findEvent(logs, ADDRESSES.pool, poolAbi, "PassedThrough");
      return { requestId: null, received: (passed?.assets as bigint | undefined) ?? assets, paidAtOnce: true };
    },

    async sellClaim(requestId, options) {
      const { address } = await signer().catch((cause) => {
        throw explain(cause);
      });
      const queue = await readQueue();
      const index = queue.ids.findIndex((id) => Number(id) === requestId);
      if (index < 0 || !same(queue.owners[index], address)) throw new ChainError("unavailable", "This place in the queue is no longer yours to sell.");
      const [quoted] = await publicClient.readContract({ address: ADDRESSES.pool, abi: poolAbi, functionName: "quoteClaim", args: [BigInt(requestId)] });
      const minReceive = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      await send(options, { address: ADDRESSES.vault, abi: vaultAbi, functionName: "approveClaim", args: [BigInt(requestId), ADDRESSES.pool] });
      const logs = await send(options, { address: ADDRESSES.pool, abi: poolAbi, functionName: "buyClaim", args: [BigInt(requestId), minReceive, address] });
      notify();
      const bought = findEvent(logs, ADDRESSES.pool, poolAbi, "ClaimBought");
      return { received: (bought?.paid as bigint | undefined) ?? quoted };
    },

    async poolDeposit(assets, options) {
      const { address } = await signer().catch((cause) => {
        throw explain(cause);
      });
      await approveIfNeeded(options, ADDRESSES.usdc, ADDRESSES.pool, assets);
      await send(options, { address: ADDRESSES.pool, abi: poolAbi, functionName: "deposit", args: [assets, address] });
      notify();
    },

    async poolWithdraw(assets, options) {
      const { address } = await signer().catch((cause) => {
        throw explain(cause);
      });
      await send(options, { address: ADDRESSES.pool, abi: poolAbi, functionName: "withdraw", args: [assets, address, address] });
      notify();
    },

    async demoQueueWithdrawal(assets) {
      const data = await demo("queue", assets);
      return { requestId: typeof data.requestId === "number" ? data.requestId : null };
    },

    async demoRepay(assets) {
      await demo("repay", assets);
    },

    async demoBorrowIdle() {
      await demo("borrow");
    },

    demoSetNextFailure: simulationOnly,
    demoSetWrongNetwork: simulationOnly,
    demoReset: simulationOnly,
  };
}
