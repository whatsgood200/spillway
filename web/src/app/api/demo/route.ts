import { DemoError, demoAddress, demoBorrowIdle, demoQueueWithdrawal, demoRepay } from "@/lib/server/demo";
import { clientKey, overLimit } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,12}$/.test(value)) return null;
  return BigInt(value);
}

/** Demo account status: its public address, so the page can label its transactions as ours. */
export async function GET() {
  return Response.json({ data: { address: demoAddress() }, error: null });
}

export async function POST(request: Request) {
  // Each action sends several transactions from a shared account, so the limit is tight.
  const wait = overLimit(`demo:${clientKey(request)}`, 5, 60_000);
  if (wait > 0) {
    return Response.json({ data: null, error: `Slow down: the demo account allows 5 actions a minute. Try again in ${wait} s.` }, { status: 429, headers: { "retry-after": String(wait) } });
  }

  let body: { action?: unknown; amount?: unknown };
  try {
    const text = await request.text();
    if (text.length > 200) throw new Error("too large");
    body = JSON.parse(text);
  } catch {
    return Response.json({ data: null, error: "Send a small JSON body with an action." }, { status: 400 });
  }

  try {
    if (body.action === "borrow") return Response.json({ data: await demoBorrowIdle(), error: null });
    const amount = parseAmount(body.amount);
    if (amount === null) return Response.json({ data: null, error: "The amount must be a whole number of USDC units." }, { status: 400 });
    if (body.action === "queue") return Response.json({ data: await demoQueueWithdrawal(amount), error: null });
    if (body.action === "repay") return Response.json({ data: await demoRepay(amount), error: null });
    return Response.json({ data: null, error: "Unknown action. Use queue, repay or borrow." }, { status: 400 });
  } catch (cause) {
    if (cause instanceof DemoError) return Response.json({ data: null, error: cause.message }, { status: cause.status });
    console.error("demo action failed", cause);
    return Response.json({ data: null, error: "The demo transaction did not go through. Try again in a moment." }, { status: 502 });
  }
}
