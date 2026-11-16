/**
 * Pool fee limits, the same numbers as `InstantPool`. The fee has a drain part (8 to 300 bps, rising as the
 * pool's cash runs down) and a wait part (up to 200 bps, rising with the line ahead); the whole is capped at 500.
 * The simulation models the drain part only.
 */
export const MIN_FEE_BPS = 8;
export const MAX_DRAIN_BPS = 300;
export const MAX_FEE_BPS = 500;

export function poolFeeBps(idleAfterPayout: bigint, poolTotal: bigint): number {
  if (poolTotal <= 0n || idleAfterPayout <= 0n) return MAX_DRAIN_BPS;
  const drainedBps = 10_000 - Number((idleAfterPayout * 10_000n) / poolTotal);
  return Math.round(MIN_FEE_BPS + ((MAX_DRAIN_BPS - MIN_FEE_BPS) * drainedBps) / 10_000);
}

export function feeFor(assets: bigint, feeBps: number): bigint {
  return (assets * BigInt(feeBps)) / 10_000n;
}
