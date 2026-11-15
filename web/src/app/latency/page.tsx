"use client";

import { getChain } from "@/lib/chain";
import { formatBps, formatMs, formatUsdc, shortHash } from "@/lib/format";
import { useChainQuery } from "@/lib/useChain";

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
              </>
            )}
          </section>

          <section className="panel" aria-label="Race experiment">
            <h2 className="label">Why one second matters</h2>
            <p className="empty">Freed liquidity is contested. A competing borrower tries to take each repayment a fixed delay after it lands. This is how much of it reached the queue first.</p>
            {data && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Borrower is behind by</th>
                      <th className="num">Reached the queue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.race.map((row) => (
                      <tr key={row.delaySeconds}>
                        <td>{row.delaySeconds} s</td>
                        <td className={`num${row.toQueueBps >= 9000 ? " good" : ""}`}>{formatBps(row.toQueueBps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">On the previous Reactive Network, with blocks about 7 s apart, a borrower 2 s behind would have won every time.</p>
          </section>
        </div>
      )}

      {loops.data && loops.data.length > 0 && (
        <section className="panel" style={{ marginTop: "var(--space-5)" }} aria-label="Raw loops">
          <h2 className="label">Latest 25 loops, raw</h2>
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
                    <td>{shortHash(loop.repayTx)}</td>
                    <td>{shortHash(loop.reactiveTx)}</td>
                    <td>{shortHash(loop.payoutTx)}</td>
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
