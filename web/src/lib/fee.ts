/**
 * Pool fee curve. The fee rises linearly as the pool's idle cash drains,
 * the same shape Sanctum uses for instant unstake. The contract will mirror these numbers.
 */
export const MIN_FEE_BPS = 8;
export const MAX_FEE_BPS = 300;

export function poolFeeBps(idleAfterPayout: bigint, poolTotal: bigint): number {
  if (poolTotal <= 0n || idleAfterPayout <= 0n) return MAX_FEE_BPS;
  const drainedBps = 10_000 - Number((idleAfterPayout * 10_000n) / poolTotal);
  return Math.round(MIN_FEE_BPS + ((MAX_FEE_BPS - MIN_FEE_BPS) * drainedBps) / 10_000);
}

export function feeFor(assets: bigint, feeBps: number): bigint {
  return (assets * BigInt(feeBps)) / 10_000n;
}
