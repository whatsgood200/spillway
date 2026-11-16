import "server-only";

/**
 * Small in-memory limiter: a fixed window per key. Enough for one server instance on a testnet demo.
 * Returns the seconds to wait when the caller is over the limit, or 0 when the call may proceed.
 */
const windows = new Map<string, { startedAt: number; count: number }>();

export function overLimit(key: string, limit: number, windowMs: number): number {
  const now = Date.now();
  const window = windows.get(key);
  if (!window || now - window.startedAt >= windowMs) {
    windows.set(key, { startedAt: now, count: 1 });
    return 0;
  }
  window.count++;
  if (window.count <= limit) return 0;
  return Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000));
}

export function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
