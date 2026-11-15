"use client";

import { useState } from "react";
import { AmountField } from "@/components/AmountField";
import { TxButton } from "@/components/TxButton";
import { getChain } from "@/lib/chain";
import { MAX_FEE_BPS, MIN_FEE_BPS } from "@/lib/fee";
import { formatBps, formatUsdc, parseUsdc } from "@/lib/format";
import { useChainQuery, useNow } from "@/lib/useChain";

export default function PoolPage() {
  const now = useNow(5000);
  const [input, setInput] = useState("1000");
  const assets = parseUsdc(input);
  const wallet = useChainQuery((chain) => chain.getWallet(), "wallet");
  const pool = useChainQuery((chain) => chain.getPoolState(), "pool");
  const queue = useChainQuery((chain) => chain.getQueue(), "queue");
  const connected = wallet.data?.status === "connected" ? wallet.data : undefined;
  const held = queue.data?.filter((entry) => entry.heldByPool) ?? [];

  return (
    <>
      <section className="hero">
        <p className="label">Pool</p>
        <h1>
          Get paid to wait in <em>line</em>.
        </h1>
        <p className="lead">The pool buys queue places from lenders who want cash now, at a discount. When the vault pays those places, the pool gets the full amount back. The discount is your income.</p>
      </section>

      <div className="grid">
        <section className="panel" aria-label="Provide liquidity">
          <h2 className="label">Your pool position</h2>
          <AmountField id="pool-amount" label="Amount" value={input} onChange={setInput} max={connected?.usdc} maxLabel="In your wallet" />
          <dl className="rows" style={{ marginBottom: "var(--space-4)" }}>
            <div>
              <dt>You have in the pool</dt>
              <dd>{formatUsdc(connected?.poolBalance ?? 0n)} USDC</dd>
            </div>
            <div>
              <dt>Back right away</dt>
              <dd>nothing; income arrives as places are paid</dd>
            </div>
            <div>
              <dt>Most you can lose</dt>
              <dd>what the pool paid for places the vault never repays</dd>
            </div>
            <div>
              <dt>Most you can make</dt>
              <dd>
                {formatBps(MIN_FEE_BPS)} to {formatBps(MAX_FEE_BPS)} per place bought
              </dd>
            </div>
          </dl>
          <div className="actions">
            <TxButton
              label={assets ? `Add ${formatUsdc(assets)} USDC to the pool` : "Add to the pool"}
              wallet={wallet.data}
              blocked={!assets ? "Enter an amount." : connected && assets > connected.usdc ? "That is more USDC than your wallet holds." : null}
              action={async (options) => {
                if (assets) await getChain().poolDeposit(assets, options);
              }}
            />
            <TxButton
              label={assets ? `Take ${formatUsdc(assets)} USDC out` : "Take out"}
              wallet={wallet.data}
              secondary
              blocked={!assets ? "Enter an amount." : connected && assets > connected.poolBalance ? "That is more than you have in the pool." : null}
              action={async (options) => {
                if (assets) await getChain().poolWithdraw(assets, options);
              }}
            />
          </div>
          <p className="muted">You can only take out cash the pool is holding. Cash spent on queue places comes back when the vault pays them. Share accounting is simplified in this preview.</p>
        </section>

        <section className="panel" aria-label="Pool state">
          <h2 className="label">The pool right now</h2>
          {pool.error && (
            <p className="error" role="alert">
              {pool.error} <button type="button" className="link-button" onClick={pool.reload}>Try again</button>
            </p>
          )}
          <dl className="stats">
            <div>
              <dd>{pool.data ? formatUsdc(pool.data.idle, 0) : <span className="skeleton" />}</dd>
              <dt>USDC ready to buy places</dt>
            </div>
            <div>
              <dd>{pool.data ? formatBps(pool.data.depthBps) : <span className="skeleton" />}</dd>
              <dt>Of the pool held as cash</dt>
            </div>
            <div>
              <dd>{pool.data ? formatBps(pool.data.feeBpsNow) : <span className="skeleton" />}</dd>
              <dt>Fee on the next place</dt>
            </div>
            <div>
              <dd>{pool.data ? formatUsdc(pool.data.feesEarned) : <span className="skeleton" />}</dd>
              <dt>USDC earned in fees</dt>
            </div>
          </dl>
          <h2 className="label" style={{ marginTop: "var(--space-5)" }}>
            Places the pool is waiting on
          </h2>
          {queue.data && held.length === 0 && <p className="empty">The pool holds no queue places. It buys one each time a lender chooses cash now.</p>}
          {held.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Place</th>
                    <th>Request</th>
                    <th className="num">Waiting</th>
                    <th className="num">Owed USDC</th>
                  </tr>
                </thead>
                <tbody>
                  {held.map((entry) => (
                    <tr key={entry.requestId}>
                      <td>{entry.position}</td>
                      <td>{entry.requestId}</td>
                      <td className="num">{Math.max(1, Math.round((now - entry.queuedAtMs) / 60000))} min</td>
                      <td className="num">{formatUsdc(entry.assets)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
