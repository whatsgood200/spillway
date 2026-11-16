import { getClaimDetail } from "@/lib/server/history";
import { clientKey, overLimit } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const wait = overLimit(`claim:${clientKey(request)}`, 30, 10_000);
  if (wait > 0) {
    return Response.json({ data: null, error: "Too many requests. Try again shortly." }, { status: 429, headers: { "retry-after": String(wait) } });
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[1-9]\d{0,8}$/.test(id)) return Response.json({ data: null, error: "The request id must be a positive whole number." }, { status: 400 });
  try {
    return Response.json({ data: await getClaimDetail(Number(id)), error: null });
  } catch (cause) {
    console.error("claim lookup failed", cause);
    return Response.json({ data: null, error: "Could not read this request from the network. Try again." }, { status: 502 });
  }
}
