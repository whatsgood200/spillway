"use client";

import Link from "next/link";
import { useChainQuery } from "@/lib/useChain";
import { TxLink } from "@/components/TxLink";
import { formatBps, formatMs, formatUsdc } from "@/lib/format";

/** The line as tickets, the vault's numbers and the latest payouts. Shown beside every money action. */
export function VaultPanel({ label }: { label: string }) {
  const vault = useChainQuery((chain) => chain.getVaultState(), "vault");
  const queue = useChainQuery((chain) => chain.getQueue(), "queue");
  const stats = useChainQuery((chain) => chain.getLatencyStats(), "stats");
  const loops = useChainQuery((chain) => chain.getLoops(3), "loops-3");
  const failed = vault.error ?? queue.error ?? stats.error ?? loops.error;

  return (
    <aside className="panel" aria-label="Vault and queue">
      <h2 className="label">{label}</h2>
      {failed && (
        <p className="error" role="alert">
          {failed} <button type="button" className="link-button" onClick={() => [vault, queue, stats, loops].forEach((q) => q.reload())}>Try again</button>
        </p>
      )}
      {queue.data && queue.data.length === 0 && <p className="empty">Nobody is waiting. Withdrawals are paid at once while the vault has cash.</p>}
      {queue.data && queue.data.length > 0 && (
        <>
          <ol className="tickets">
            {queue.data.map((entry) => (
              <li key={entry.requestId} className={`ticket${entry.mine ? " mine" : ""}${entry.heldByPool ? " pool" : ""}`}>
                <b>{entry.position}</b>
                {entry.mine ? "you" : formatUsdc(entry.assets, 0)}
              </li>
            ))}
          </ol>
          <p className="muted">Paid first to last, in USDC. Dashed places were bought by the pool.</p>
        </>
      )}
      <dl className="stats">
        <div>
          <dd>{vault.data ? formatBps(vault.data.utilizationBps) : <span className="skeleton" />}</dd>
          <dt>Vault lent out</dt>
        </div>
        <div>
          <dd>{vault.data ? formatUsdc(vault.data.withdrawable) : <span className="skeleton" />}</dd>
          <dt>USDC withdrawable</dt>
        </div>
        <div>
          <dd>{stats.data ? (stats.data.count ? formatMs(stats.data.p50) : "No data") : <span className="skeleton" />}</dd>
          <dt>Median payout after repayment</dt>
        </div>
        <div>
          <dd>{stats.data ? stats.data.count : <span className="skeleton" />}</dd>
          <dt>Loops measured</dt>
        </div>
      </dl>
      {loops.data && loops.data.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Last payouts</th>
                <th className="num">USDC</th>
                <th className="num">After repayment</th>
              </tr>
            </thead>
            <tbody>
              {loops.data.map((loop) => (
                <tr key={loop.id}>
                  <td>
                    <TxLink hash={loop.payoutTx} network="base-sepolia" />
                  </td>
                  <td className="num">{formatUsdc(loop.assets)}</td>
                  <td className="num good">{formatMs(loop.latencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        <Link href="/latency">How these times are measured</Link>
      </p>
    </aside>
  );
}
