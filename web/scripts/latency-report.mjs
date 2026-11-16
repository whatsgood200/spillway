// Recomputes every loop's latency from the chain alone, independent of the runner's own log:
// SpillwayCallback.loops() gives the origin block and the millisecond time the vault paid; the origin block's
// millisecond timestamp comes from the Base Sepolia RPC. Writes measurements/latency-<date>.json and prints a summary.
// Run from web/:  node scripts/latency-report.mjs
import { writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const CALLBACK = "0xfCA6031Dd3655CdB2B6D47F0A84F3e3e7c812C20";
const abi = parseAbi([
  "struct Loop { uint256 originTxHash; uint64 originBlock; uint64 payoutBlock; uint64 paidAtMs; uint32 settled; uint256 assets; }",
  "function loopCount() view returns (uint256)",
  "function loopsSlice(uint256,uint256) view returns (Loop[])",
]);
const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org", { retryCount: 5, retryDelay: 800 }) });

const count = Number(await client.readContract({ address: CALLBACK, abi, functionName: "loopCount" }));
const loops = [];
for (let offset = 0; offset < count; offset += 100) {
  loops.push(...(await client.readContract({ address: CALLBACK, abi, functionName: "loopsSlice", args: [BigInt(offset), 100n] })));
}

const rows = [];
for (const [index, loop] of loops.entries()) {
  const block = await client.request({ method: "eth_getBlockByNumber", params: [`0x${loop.originBlock.toString(16)}`, false] });
  const originMs = Number(BigInt(block.timestampMs ?? `${BigInt(block.timestamp) * 1000n}`));
  rows.push({
    loop: index + 1,
    originTx: `0x${loop.originTxHash.toString(16).padStart(64, "0")}`,
    originBlock: Number(loop.originBlock),
    payoutBlock: Number(loop.payoutBlock),
    blocks: Number(loop.payoutBlock - loop.originBlock),
    latencyMs: Number(loop.paidAtMs) - originMs,
    settled: loop.settled,
    usdc: Number(loop.assets) / 1e6,
  });
}

const sorted = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const summary = {
  source: `SpillwayCallback ${CALLBACK} on Base Sepolia, loops 1 to ${rows.length}`,
  loops: rows.length,
  p50: at(0.5),
  p90: at(0.9),
  p95: at(0.95),
  p99: at(0.99),
  min: sorted[0],
  max: sorted[sorted.length - 1],
  mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  underTwoSeconds: rows.filter((row) => row.latencyMs <= 2000).length,
  generatedAt: new Date().toISOString(),
};
const day = summary.generatedAt.slice(0, 10);
writeFileSync(new URL(`../../measurements/latency-${day}.json`, import.meta.url), JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
