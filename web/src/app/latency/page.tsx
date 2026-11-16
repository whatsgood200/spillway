"use client";

import { getChain } from "@/lib/chain";
import { TxLink } from "@/components/TxLink";
import { formatMs, formatUsdc } from "@/lib/format";
import { useChainQuery } from "@/lib/useChain";
import morpho from "@/data/morpho.json";

const percent = (share: number) => `${Math.round(share * 100)} %`;
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;

export default function LatencyPage() {
  const stats = useChainQuery((chain) => chain.getLatencyStats(), "stats");
  const loops = useChainQuery((chain) => chain.getLoops(25), "loops-25");
  const data = stats.data;
  const tallest = data ? Math.max(1, ...data.histogram.map((bucket) => bucket.count)) : 1;

  return (
    <>
      <section className="hero">
        <p className="label">Latency</p>
        <h1>
          Repayment to payout, <em>measured</em>.
        </h1>
        <p className="lead">Every loop is timed on chain: the millisecond timestamp of the block that held the repayment, against the millisecond timestamp the vault recorded when it paid the queue.</p>
        {getChain().isMock && <p className="muted">Sample data. Real measurements replace these numbers when the contracts are live.</p>}
      </section>

      {stats.error && (
        <p className="error" role="alert">
          {stats.error} <button type="button" className="link-button" onClick={stats.reload}>Try again</button>
        </p>
      )}

      {data && data.count === 0 && <p className="empty">No loops measured yet. Send a repayment from the demo console while someone is in the queue.</p>}

      {(!data || data.count > 0) && (
        <div className="grid">
          <section className="panel" aria-label="Distribution">
            <h2 className="label">All loops · {data ? data.count : "reading"}</h2>
            <dl className="stats">
              <div>
                <dd>{data ? formatMs(data.p50) : <span className="skeleton" />}</dd>
                <dt>Median (p50)</dt>
              </div>
              <div>
                <dd>{data ? formatMs(data.p90) : <span className="skeleton" />}</dd>
                <dt>p90</dt>
              </div>
              <div>
                <dd>{data ? formatMs(data.p99) : <span className="skeleton" />}</dd>
                <dt>p99</dt>
              </div>
              <div>
                <dd>{data ? `${formatMs(data.min)} to ${formatMs(data.max)}` : <span className="skeleton" />}</dd>
                <dt>Fastest to slowest</dt>
              </div>
            </dl>
            {data && (
              <>
                <ol className="bars" aria-label="Number of loops by latency, in 200 millisecond steps">
                  {data.histogram.map((bucket) => (
                    <li key={bucket.fromMs} title={`${bucket.count} loops at ${bucket.fromMs} ms`}>
                      {bucket.count}
                      <span style={{ height: `${(bucket.count / tallest) * 85}%` }} />
                    </li>
                  ))}
                </ol>
                <ol className="axis" aria-hidden="true">
                  {data.histogram.map((bucket) => (
                    <li key={bucket.fromMs}>{(bucket.fromMs / 1000).toFixed(1)}</li>
                  ))}
                </ol>
                <p className="muted">Seconds from repayment to payout. Base Sepolia makes a block every 200 ms, so times fall in 200 ms steps.</p>
                {!getChain().isMock && (
                  <p className="muted">
                    These are the current contracts (v3). The earlier contracts (v2) ran 204 loops: median 1.6 s, p90 2.4 s, p99 4.0 s. Both runs are in{" "}
                    <a href="https://github.com/whatsgood200/spillway/tree/main/measurements" target="_blank" rel="noreferrer">
                      measurements
                    </a>
                    .
                  </p>
                )}
              </>
            )}
          </section>

          <section className="panel" aria-label="Race experiment">
            <h2 className="label">Why one second matters</h2>
            <p className="empty">
              Cash a borrower repays is contested. In each trial a competing borrower tried to take exactly that cash, some time after the repayment. Whoever landed first got it.
            </p>
            {data && data.race.length === 0 && <p className="empty">Not measured yet. The experiment has not been run on the live contracts.</p>}
            {data && data.race.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Competitor landed after the repayment</th>
                      <th className="num">Queue got the cash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.race.map((row) => (
                      <tr key={row.delayMs}>
                        <td>
                          {formatMs(row.medianLagMs)}
                          {row.minLagMs !== row.maxLagMs && ` (${formatMs(row.minLagMs)} to ${formatMs(row.maxLagMs)})`}
                        </td>
                        <td className={`num${row.queueWins === row.trials ? " good" : ""}`}>
                          {row.queueWins} of {row.trials}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data?.raceSource && <p className="muted">Source: {data.raceSource}. The competitor is our own demo account.</p>}
            <p className="muted">
              On the previous Reactive Network, with blocks about 7 s apart, the loop alone took longer than any of these delays (an estimate from block times, not
              measured).
            </p>
          </section>
        </div>
      )}

      <section className="panel" style={{ marginTop: "var(--space-5)" }} aria-label="Real data from Base mainnet">
        <h2 className="label">The same moment on Base mainnet · one year of real data</h2>
        <p className="empty">
          In the {morpho.markets} listed Morpho Blue markets on Base that ran out of cash in the last year, a borrower repaid while the market had 0.5 % or less of its cash left{" "}
          {morpho.repaymentsIntoDryMarket} times. Nobody was queued to receive that cash.
        </p>
        <dl className="stats">
          <div>
            <dd>{hours(morpho.medianMs)}</dd>
            <dt>Median time until someone took it</dt>
          </div>
          <div>
            <dd>{morpho.takenWithin2s} of {morpho.taken}</dd>
            <dt>Taken within 2 s</dt>
          </div>
          <div>
            <dd>{morpho.fastestMs / 1000} s</dd>
            <dt>Fastest anyone took it</dt>
          </div>
          <div>
            <dd>{percent(morpho.takenByShare.directLenders)}</dd>
            <dt>Of what was taken, went to lenders withdrawing directly</dt>
          </div>
        </dl>
        <p className="muted">
          A lender who wanted out had to notice the cash and act before anyone else; {percent(morpho.takenByShare.borrowers)} of it went back to borrowers and{" "}
          {morpho.notTakenWithin24h} repayments sat untouched for a day. Spillway pays the people already waiting, in order, about 1.5 s after the repayment, faster than
          any taker seen here. Base mainnet made a block every 2 s for most of this year and moved to 200 ms in November 2026, so takers may get faster.
        </p>
        <p className="muted">
          {morpho.transactions.toLocaleString("en-US")} transactions from the public Morpho API, {morpho.window.from} to {morpho.window.to}, liquidity rebuilt exactly and checked
          against Morpho&apos;s hourly figures. Source:{" "}
          <a href={`https://github.com/whatsgood200/spillway/blob/main/${morpho.source}`} target="_blank" rel="noreferrer">
            {morpho.source}
          </a>
          , method in{" "}
          <a href="https://github.com/whatsgood200/spillway/blob/main/web/scripts/morpho-crunch.mjs" target="_blank" rel="noreferrer">
            morpho-crunch.mjs
          </a>
          .
        </p>
      </section>

      {loops.data && loops.data.length > 0 && (
        <section className="panel" style={{ marginTop: "var(--space-5)" }} aria-label="Raw loops">
          <h2 className="label">Latest {loops.data.length} loops, raw</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Loop</th>
                  <th>Repayment · Base Sepolia</th>
                  <th>Reactive tx · Lasna</th>
                  <th>Payout · Base Sepolia</th>
                  <th className="num">USDC</th>
                  <th className="num">Latency</th>
                </tr>
              </thead>
              <tbody>
                {loops.data.map((loop) => (
                  <tr key={loop.id}>
                    <td>{loop.id}</td>
                    <td>
                      <TxLink hash={loop.repayTx} network="base-sepolia" />
                    </td>
                    <td>
                      <TxLink hash={loop.reactiveTx} network="lasna" />
                    </td>
                    <td>
                      <TxLink hash={loop.payoutTx} network="base-sepolia" />
                    </td>
                    <td className="num">{formatUsdc(loop.assets)}</td>
                    <td className="num good">{loop.latencyMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
