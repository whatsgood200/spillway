// How fast is cash freed by a repayment taken back in a fully lent-out Morpho Blue market, and by whom?
// Real data: every liquidity-moving transaction in the listed Base mainnet markets that reached full utilization
// in the last year, from the public Morpho API (https://blue-api.morpho.org/graphql), no key needed.
//
// Method
// - Liquidity (supply minus borrow) changes only through Supply (+), Withdraw (-), Borrow (-), Repay (+) and the
//   repaid part of a Liquidation (+). Interest and bad debt move supply and borrow by the same amount, so they
//   leave liquidity unchanged. Liquidity after every transaction is rebuilt backwards from the market's current
//   on-chain liquidity, exactly.
// - A repayment is "into a dry market" when liquidity just before it is at most DRY_SHARE of total supply.
// - The freed cash is "taken" when liquidity falls back to within 10 percent of the freed amount above where it was.
//   Time taken is measured between the two blocks. Base mainnet made a block every 2 s until block 53,556,127
//   (timestamp 1793901601) and every 200 ms after it, so block times are exact to the millisecond.
// - Cash taken back inside the repayment's own transaction (a borrower refinancing atomically) is reported apart.
//
// Run from web/:  node scripts/morpho-crunch.mjs
// Raw API pages are cached in web/.cache/morpho (git-ignored); the result goes to measurements/morpho-base-<date>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://blue-api.morpho.org/graphql";
const CHAIN = 8453;
const DAYS = 365;
const MIN_FULL_HOURS = 5; // a market is studied if hourly snapshots show at least this many hours at >= 99.5 % utilization
const DRY_SHARE = 0.005; // dry: liquidity at most 0.5 % of total supply
const MIN_REPAY_SHARE = 0.0001; // ignore repayments smaller than 0.01 % of total supply
const TAKEN_SHARE = 0.9;
const FAST_BLOCKS_FROM = 53_556_127; // last 2 s block; one block every 200 ms after it
const FAST_BLOCKS_FROM_MS = 1_793_901_601_000;
const blockMs = (block, t) => (block <= FAST_BLOCKS_FROM ? t * 1000 : FAST_BLOCKS_FROM_MS + (block - FAST_BLOCKS_FROM) * 200);
const HORIZON_S = 24 * 3600;
const CACHE = ".cache/morpho";

mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function q(query) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      const body = await response.json();
      if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
      return body.data;
    } catch (error) {
      if (attempt >= 5) throw error;
      await sleep(2000 * attempt);
    }
  }
}

// END_TIME pins the window (unix seconds) so a rerun reuses the cache and gives the same numbers.
const now = Number(process.env.END_TIME ?? Math.floor(Date.now() / 1000));
const start = now - DAYS * 86400;

async function hourly(marketId, field) {
  const points = [];
  for (let a = start; a < now; a += 180 * 86400) {
    const b = Math.min(now, a + 180 * 86400);
    const data = await q(`{ marketById(marketId: "${marketId}", chainId: ${CHAIN}) { historicalState { ${field}(options: {startTimestamp: ${a}, endTimestamp: ${b}, interval: HOUR}) { x y } } } }`);
    points.push(...data.marketById.historicalState[field]);
  }
  // The API returns each series newest first.
  return points.filter((p) => p.y !== null).sort((a, b) => a.x - b.x);
}

const FIELDS = "txHash timestamp blockNumber txIndex logIndex type user { address } data { ... on MarketTransactionTransferData { assets } ... on MarketTransactionLiquidationData { repaidAssets } }";

const PAGE = 1000;
let duplicates = 0;

/**
 * Every transaction in a time window, in one page: a window with more than a page is split in half until it fits,
 * because transactions that share a second come back in no fixed order and paging could skip some. Each window is
 * checked against the API's own count.
 */
async function window(marketId, from, to) {
  const where = `{chainId_in: [${CHAIN}], marketUniqueKey_in: ["${marketId}"], type_in: [Supply, Withdraw, Borrow, Repay, Liquidation], timestamp_gte: ${from}, timestamp_lte: ${to}}`;
  const data = await q(`{ marketTransactions(first: ${PAGE}, orderBy: Timestamp, orderDirection: Asc, where: ${where}) { pageInfo { countTotal } items { ${FIELDS} } } }`);
  const { countTotal } = data.marketTransactions.pageInfo;
  const items = data.marketTransactions.items;
  if (countTotal > PAGE && to > from) {
    const middle = Math.floor((from + to) / 2);
    return [...(await window(marketId, from, middle)), ...(await window(marketId, middle + 1, to))];
  }
  if (items.length !== countTotal) throw new Error(`${marketId} ${from}-${to}: got ${items.length} of ${countTotal} transactions`);
  const rows = new Map(items.map((item) => [`${item.txHash}:${item.logIndex}`, item]));
  duplicates += items.length - rows.size;
  return [...rows.values()];
}

const toRow = (item) => ({
  hash: item.txHash,
  t: Number(item.timestamp),
  block: Number(item.blockNumber),
  txIndex: item.txIndex,
  logIndex: item.logIndex,
  type: item.type,
  user: item.user.address.toLowerCase(),
  assets: String(item.data.assets ?? item.data.repaidAssets ?? "0"),
});

/** Every liquidity-moving transaction of a market since `start`, one week at a time, cached. */
async function transactions(marketId) {
  const file = `${CACHE}/${marketId}-${start}-v2.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const rows = [];
  for (let from = start; from <= now; from += 7 * 86400) {
    const items = await window(marketId, from, Math.min(now, from + 7 * 86400 - 1));
    rows.push(...items.map(toRow));
    process.stdout.write(`\r  ${rows.length} transactions, up to ${new Date(from * 1000).toISOString().slice(0, 10)}   `);
  }
  process.stdout.write("\n");
  writeFileSync(file, JSON.stringify(rows));
  return rows;
}

async function vaultAddresses() {
  const addresses = new Set();
  for (let skip = 0; ; skip += 1000) {
    const data = await q(`{ vaults(first: 1000, skip: ${skip}, where: {chainId_in: [${CHAIN}]}) { items { address } } }`);
    for (const vault of data.vaults.items) addresses.add(vault.address.toLowerCase());
    if (data.vaults.items.length < 1000) break;
  }
  try {
    const data = await q(`{ vaultV2s(first: 1000, where: {chainId_in: [${CHAIN}]}) { items { address } } }`);
    for (const vault of data.vaultV2s.items) addresses.add(vault.address.toLowerCase());
  } catch {
    // Older API without V2 vaults.
  }
  return addresses;
}

const DELTA = { Supply: 1n, Repay: 1n, Liquidation: 1n, Withdraw: -1n, Borrow: -1n };
const quantile = (values, share) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
};

const listed = (
  await q(`{ markets(first: 200, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: {chainId_in: [${CHAIN}], listed: true}) { items { marketId loanAsset { symbol decimals } collateralAsset { symbol } state { supplyAssetsUsd liquidityAssets blockNumber timestamp } } } }`)
).markets.items.filter((market) => market.state.supplyAssetsUsd > 1e6);
const vaults = await vaultAddresses();
console.log(`${listed.length} listed Base markets over 1M USD, ${vaults.size} vault addresses`);

const events = [];
const markets = [];
for (const market of listed) {
  const name = `${market.loanAsset.symbol}/${market.collateralAsset?.symbol ?? "none"}`;
  const utilization = await hourly(market.marketId, "utilization");
  const fullHours = utilization.filter((p) => p.y >= 0.995).length;
  if (fullHours < MIN_FULL_HOURS) continue;
  console.log(`${name} ${market.marketId.slice(0, 10)}: ${fullHours} hours at >= 99.5 % utilization`);
  const supply = await hourly(market.marketId, "supplyAssets");
  // The window ends at END_TIME; transactions from then to the current state are fetched too, so the rebuild
  // starts from the exact current liquidity.
  const tail = Number(market.state.timestamp) > now ? (await window(market.marketId, now + 1, Number(market.state.timestamp))).map(toRow) : [];
  const txs = [...(await transactions(market.marketId)), ...tail].filter((tx) => tx.block <= Number(market.state.blockNumber));
  txs.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex);

  // Liquidity after each transaction, rebuilt backwards from the current state.
  const after = new Array(txs.length);
  let liquidity = BigInt(market.state.liquidityAssets);
  for (let i = txs.length - 1; i >= 0; i--) {
    after[i] = liquidity;
    liquidity -= DELTA[txs[i].type] * BigInt(txs[i].assets);
  }
  const negative = after.filter((value) => value < 0n).length;

  // Check the rebuild against the API's own hourly liquidity: the error, as a share of total supply, at each hour.
  const snapshots = await hourly(market.marketId, "liquidityAssets");
  const errors = [];
  let k = -1;
  for (const point of snapshots) {
    while (k + 1 < txs.length && txs[k + 1].t <= point.x) k++;
    if (k < 0) continue;
    const total = supply.find((p) => p.x === point.x)?.y;
    if (!total) continue;
    errors.push(Math.abs(Number(after[k]) - point.y) / total);
  }
  const errorP95 = quantile(errors, 0.95) ?? 1;
  const consistent = negative === 0 && errorP95 <= 0.01;

  let s = 0;
  const supplyAt = (t) => {
    while (s + 1 < supply.length && supply[s + 1].x <= t) s++;
    return BigInt(Math.round(supply[s]?.y ?? 0));
  };
  const scale = 10 ** market.loanAsset.decimals;
  let studied = 0;
  for (let i = 0; consistent && i < txs.length; i++) {
    const tx = txs[i];
    if (tx.type !== "Repay" && tx.type !== "Liquidation") continue;
    const total = supplyAt(tx.t);
    const freed = BigInt(tx.assets);
    const before = after[i] - freed;
    if (total === 0n || before * 1000n > total * BigInt(DRY_SHARE * 1000) || freed * 10000n < total * BigInt(MIN_REPAY_SHARE * 10000)) continue;
    studied++;
    const target = before + freed - (freed * BigInt(TAKEN_SHARE * 100)) / 100n;
    const takers = { vault: 0n, lender: 0n, borrower: 0n };
    let takenAt = null;
    for (let j = i + 1; j < txs.length && txs[j].t - tx.t <= HORIZON_S; j++) {
      const next = txs[j];
      const amount = BigInt(next.assets);
      if (next.type === "Withdraw") takers[vaults.has(next.user) ? "vault" : "lender"] += amount;
      if (next.type === "Borrow") takers.borrower += amount;
      if (after[j] <= target) {
        takenAt = j;
        break;
      }
    }
    const taken = takenAt !== null ? txs[takenAt] : null;
    events.push({
      market: name,
      marketId: market.marketId,
      block: tx.block,
      time: new Date(tx.t * 1000).toISOString(),
      tx: tx.hash,
      kind: tx.type,
      freed: Number(freed) / scale,
      liquidityBefore: Number(before) / scale,
      supply: Number(total) / scale,
      taken: taken !== null,
      sameTx: taken !== null && taken.hash === tx.hash,
      takenAfterMs: taken !== null ? blockMs(taken.block, taken.t) - blockMs(tx.block, tx.t) : null,
      takenBy: Object.fromEntries(Object.entries(takers).map(([key, value]) => [key, Number(value) / scale])),
      takenTx: taken?.hash ?? null,
    });
  }
  markets.push({
    name,
    marketId: market.marketId,
    fullHours,
    transactions: txs.length,
    negativeLiquidityRows: negative,
    hourlyCheckP95ErrorShareOfSupply: errorP95,
    included: consistent,
    repaymentsIntoDryMarket: studied,
  });
  console.log(
    `  ${txs.length} transactions; rebuild vs hourly liquidity p95 error ${(errorP95 * 100).toFixed(3)} % of supply${negative ? `, ${negative} rows below zero` : ""}; ${consistent ? `${studied} repayments into a dry market` : "EXCLUDED: rebuild does not match"}`,
  );
}

const raced = events.filter((event) => event.taken && !event.sameTx);
const times = raced.map((event) => event.takenAfterMs);
const share = (ms) => (raced.length ? raced.filter((event) => event.takenAfterMs <= ms).length / raced.length : null);
const byVault = raced.reduce((sum, e) => sum + e.takenBy.vault, 0);
const byLender = raced.reduce((sum, e) => sum + e.takenBy.lender, 0);
const byBorrower = raced.reduce((sum, e) => sum + e.takenBy.borrower, 0);
const summary = {
  repaymentsIntoDryMarket: events.length,
  takenBackInTheSameTransaction: events.filter((event) => event.sameTx).length,
  takenByAnotherTransaction: raced.length,
  notTakenWithin24h: events.filter((event) => !event.taken).length,
  medianMs: quantile(times, 0.5),
  p25Ms: quantile(times, 0.25),
  p75Ms: quantile(times, 0.75),
  p90Ms: quantile(times, 0.9),
  takenWithin: { "1s": share(1000), "2s": share(2000), "10s": share(10000), "60s": share(60000), "10min": share(600000), "1h": share(3600000) },
  takenByShare: { vaults: byVault / (byVault + byLender + byBorrower), directLenders: byLender / (byVault + byLender + byBorrower), borrowers: byBorrower / (byVault + byLender + byBorrower) },
};

const day = new Date().toISOString().slice(0, 10);
const out = `../measurements/morpho-base-${day}.json`;
writeFileSync(
  out,
  JSON.stringify(
    {
      source: API,
      chainId: CHAIN,
      generatedAt: new Date().toISOString(),
      window: { from: new Date(start * 1000).toISOString(), to: new Date(now * 1000).toISOString() },
      method: { DRY_SHARE, MIN_REPAY_SHARE, TAKEN_SHARE, FAST_BLOCKS_FROM, HORIZON_S, MIN_FULL_HOURS, duplicateRowsDropped: duplicates },
      summary,
      markets,
      events,
    },
    null,
    1,
  ),
);
// A small copy for the latency page.
const fastest = raced.length ? raced.reduce((best, event) => (event.takenAfterMs < best.takenAfterMs ? event : best)) : null;
writeFileSync(
  "src/data/morpho.json",
  JSON.stringify(
    {
      source: `measurements/morpho-base-${day}.json`,
      window: { from: new Date(start * 1000).toISOString().slice(0, 10), to: new Date(now * 1000).toISOString().slice(0, 10) },
      markets: markets.filter((market) => market.included).length,
      transactions: markets.reduce((sum, market) => sum + market.transactions, 0),
      repaymentsIntoDryMarket: summary.repaymentsIntoDryMarket,
      taken: summary.takenByAnotherTransaction,
      notTakenWithin24h: summary.notTakenWithin24h,
      medianMs: summary.medianMs,
      fastestMs: fastest?.takenAfterMs ?? null,
      takenWithin2s: raced.filter((event) => event.takenAfterMs <= 2000).length,
      takenByShare: summary.takenByShare,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${out}`);
