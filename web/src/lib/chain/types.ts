/**
 * The single seam between the UI and everything on chain.
 * Phase 2 runs on the mock implementation; Phase 4 swaps in the real one without touching screens.
 */
export type Network = "base-sepolia" | "lasna";

export type WalletState =
  | { status: "disconnected" }
  | { status: "wrong-network"; address: string }
  | { status: "connected"; address: string; usdc: bigint; vaultBalance: bigint; poolBalance: bigint };

export interface VaultState {
  totalAssets: bigint;
  lentOut: bigint;
  withdrawable: bigint;
  utilizationBps: number;
  queueLength: number;
  queuedAssets: bigint;
}

export interface QueueEntry {
  requestId: number;
  position: number;
  assets: bigint;
  queuedAtMs: number;
  heldByPool: boolean;
  mine: boolean;
}

export interface WithdrawQuote {
  assets: bigint;
  /** True when the vault can pay in full right now and nobody is waiting. */
  paidAtOnce: boolean;
  position: number;
  aheadAssets: bigint;
  cashNow: { available: true; receive: bigint; fee: bigint; feeBps: number } | { available: false; reason: string };
}

export type ClaimStatus = "queued" | "sold" | "paid";

export interface ClaimEvent {
  kind: "queued" | "sold" | "liquidity" | "reactive" | "paid";
  /** Null when the time is not known, as for the reactive transaction on Lasna. */
  atMs: number | null;
  txHash: string;
  network: Network;
}

export interface Claim {
  requestId: number;
  /** Who asked for the withdrawal. Null in the simulation. */
  requester: string | null;
  assets: bigint;
  status: ClaimStatus;
  position: number | null;
  aheadAssets: bigint;
  received: bigint | null;
  fee: bigint | null;
  latencyMs: number | null;
  events: ClaimEvent[];
}

export interface PoolState {
  totalAssets: bigint;
  idle: bigint;
  claimsHeld: number;
  claimsValue: bigint;
  depthBps: number;
  feeBpsNow: number;
  feesEarned: bigint;
}

export interface Loop {
  id: number;
  atMs: number;
  assets: bigint;
  latencyMs: number;
  repayTx: string;
  /** Null when the reactive transaction could not be looked up on Lasna. */
  reactiveTx: string | null;
  /** Null for older loops whose payout transaction has not been looked up. */
  payoutTx: string | null;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  histogram: { fromMs: number; count: number }[];
  /** The race experiment: how often the queue got the freed cash before a competing borrower, by how late that borrower landed. */
  race: RaceRow[];
  /** Where the race rows come from, for the caption. Null when there are none. */
  raceSource: string | null;
}

export interface RaceRow {
  /** How long the competitor waited after sending the repayment. */
  delayMs: number;
  /** How late its borrow actually landed after the repayment, from block timestamps. */
  medianLagMs: number;
  minLagMs: number;
  maxLagMs: number;
  trials: number;
  queueWins: number;
}

export type ChainErrorCode = "rejected" | "reverted" | "disconnected" | "wrong-network" | "insufficient" | "unavailable";

export class ChainError extends Error {
  constructor(
    public readonly code: ChainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

export type TxPhase = "wallet" | "pending";

export interface TxOptions {
  onPhase?: (phase: TxPhase) => void;
}

export interface ChainAdapter {
  readonly isMock: boolean;
  subscribe(listener: () => void): () => void;

  getWallet(): Promise<WalletState>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  switchNetwork(): Promise<void>;

  getVaultState(): Promise<VaultState>;
  getQueue(): Promise<QueueEntry[]>;
  getPoolState(): Promise<PoolState>;
  quoteWithdraw(assets: bigint): Promise<WithdrawQuote>;
  getClaim(requestId: number): Promise<Claim | null>;
  getMyClaims(): Promise<Claim[]>;
  getLoops(limit: number): Promise<Loop[]>;
  getLatencyStats(): Promise<LatencyStats>;

  deposit(assets: bigint, options?: TxOptions): Promise<void>;
  /** Wait in line. `requestId` is null when the vault paid at once and there is no place in the queue. */
  requestRedeem(assets: bigint, options?: TxOptions): Promise<{ requestId: number | null; paidAtOnce: boolean }>;
  /** Cash now, in one step: the pool queues in its own name and pays the caller. */
  cashOut(assets: bigint, options?: TxOptions): Promise<{ requestId: number | null; received: bigint; paidAtOnce: boolean }>;
  /** Sell a place the caller already holds in the queue. */
  sellClaim(requestId: number, options?: TxOptions): Promise<{ received: bigint }>;
  poolDeposit(assets: bigint, options?: TxOptions): Promise<void>;
  poolWithdraw(assets: bigint, options?: TxOptions): Promise<void>;

  /** Demo console: actions taken by the labelled demo borrower, not by the user. */
  demoQueueWithdrawal(assets: bigint): Promise<{ requestId: number | null }>;
  demoRepay(assets: bigint): Promise<void>;
  demoBorrowIdle(): Promise<void>;
  demoSetNextFailure(failure: "rejected" | "reverted" | null): Promise<void>;
  demoSetWrongNetwork(wrong: boolean): Promise<void>;
  demoReset(mode: "seeded" | "empty"): Promise<void>;
}
