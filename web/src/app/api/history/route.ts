import { getHistory } from "@/lib/server/history";
import { clientKey, overLimit } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const wait = overLimit(`history:${clientKey(request)}`, 30, 10_000);
  if (wait > 0) {
    return Response.json({ data: null, error: "Too many requests. Try again shortly." }, { status: 429, headers: { "retry-after": String(wait) } });
  }
  try {
    return Response.json({ data: await getHistory(), error: null });
  } catch (cause) {
    console.error("history failed", cause);
    return Response.json({ data: null, error: "Could not read the event history. The explorer or RPC may be down; try again." }, { status: 502 });
  }
}
