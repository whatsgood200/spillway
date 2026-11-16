/** USDC amounts are bigint with 6 decimals everywhere in the app. */
export const USDC = 1_000_000n;

export function formatUsdc(amount: bigint, decimals = 2): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(6 - decimals);
  const rounded = (abs + scale / 2n) / scale;
  const whole = rounded / 10n ** BigInt(decimals);
  const fraction = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${decimals > 0 ? "." + fraction : ""}`;
}

/** Every cent and below: at least two decimals, up to all six, so a 0.0044 USDC fee never shows as 0.00. */
export function formatUsdcExact(amount: bigint): string {
  return formatUsdc(amount, 6).replace(/(\.\d\d\d*?)0+$/, "$1");
}

/** Parses user input such as "1,000.50". Returns null when it is not a positive amount. */
export function parseUsdc(input: string): bigint | null {
  const cleaned = input.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{0,6})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const value = BigInt(whole) * USDC + BigInt(fraction.padEnd(6, "0"));
  return value > 0n ? value : null;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function formatAgo(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}
