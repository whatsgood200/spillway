// Summarises a race run by delay, and writes the summary the latency page shows (src/data/race.json).
// Every row is grouped by the delay the competitor waited, and reports how late its borrow actually landed,
// measured from block timestamps, because that measured lag is what decides the race.
// Run from web/:  node scripts/race-report.mjs 2026-11-16
import { readFileSync, writeFileSync } from "node:fs";

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const source = `measurements/race-${day}.jsonl`;
const trials = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((trial) => !trial.failed && trial.winner !== "unclear");

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

const byDelay = new Map();
for (const trial of trials) byDelay.set(trial.delayMs, [...(byDelay.get(trial.delayMs) ?? []), trial]);

const rows = [...byDelay.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([delayMs, group]) => ({
    delayMs,
    medianLagMs: median(group.map((trial) => trial.lagMs)),
    minLagMs: Math.min(...group.map((trial) => trial.lagMs)),
    maxLagMs: Math.max(...group.map((trial) => trial.lagMs)),
    trials: group.length,
    queueWins: group.filter((trial) => trial.winner === "queue").length,
  }));

const summary = { source, generatedAt: new Date().toISOString(), trials: trials.length, rows };
writeFileSync(new URL("../src/data/race.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");

console.log(`${trials.length} trials from ${source}`);
console.log("delay ms | competitor landed after repayment (median, range) | queue won");
for (const row of rows) {
  console.log(`${String(row.delayMs).padStart(8)} | ${row.medianLagMs} ms (${row.minLagMs} to ${row.maxLagMs}) | ${row.queueWins} of ${row.trials}`);
}
