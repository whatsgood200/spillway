import "server-only";
import { fallback, http, type HttpTransportConfig } from "viem";
import { BASE_SEPOLIA_RPC } from "../chain/config";

/**
 * Server-side Base Sepolia transport. On Vercel, sepolia.base.org refuses some calls from the platform's
 * servers ("eth_call is not supported, failed to serve request", seen 2026-11-16) while it answers browsers
 * fine. The server therefore tries publicnode first and falls back to the Base endpoint.
 * BASE_SEPOLIA_SERVER_RPC can name a provider with an API key; it is read only on the server.
 */
const SERVER_RPCS = [process.env.BASE_SEPOLIA_SERVER_RPC, "https://base-sepolia-rpc.publicnode.com", BASE_SEPOLIA_RPC].filter(
  (url, index, all): url is string => Boolean(url) && all.indexOf(url) === index,
);

export function serverTransport(config: HttpTransportConfig = {}) {
  return fallback(SERVER_RPCS.map((url) => http(url, { timeout: 20_000, ...config })));
}
