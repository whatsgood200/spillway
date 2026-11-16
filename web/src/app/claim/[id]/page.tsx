"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { TxButton } from "@/components/TxButton";
import { TxLink } from "@/components/TxLink";
import { getChain, type Claim, type ClaimEvent } from "@/lib/chain";
import { formatBps, formatMs, formatUsdc } from "@/lib/format";
import { useChainQuery, useNow } from "@/lib/useChain";

const STEP_TEXT: Record<ClaimEvent["kind"], string> = {
  queued: "You joined the queue",
  sold: "You sold your place to the pool",
  liquidity: "A repayment landed in the vault",
  reactive: "Reactive Network saw it and called the vault",
  paid: "The vault paid this request",
};

const NETWORK_TEXT: Record<ClaimEvent["network"], string> = { "base-sepolia": "Base Sepolia", lasna: "Reactive Lasna" };

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function Headline({ claim, now }: { claim: Claim; now: number }) {
  if (claim.status === "sold") {
    return (
      <>
        <p className="headline-stat">Paid {formatUsdc(claim.received ?? 0n)} USDC now.</p>
        <p className="lead">
          You sold your place in the queue to the pool for a fee of {formatUsdc(claim.fee ?? 0n)} USDC. The pool now waits in your place and is repaid when the vault pays this request.
        </p>
      </>
    );
  }
  if (claim.status === "paid") {
    return (
      <>
        <p className="headline-stat">
          Paid {formatUsdc(claim.received ?? 0n)} USDC{claim.latencyMs ? `, ${formatMs(claim.latencyMs)} after a repayment landed.` : " at once."}
        </p>
        <p className="lead">{claim.latencyMs ? "No keeper and no click. The repayment itself triggered your payout." : "The vault had cash and nobody was waiting, so there was no queue."}</p>
      </>
    );
  }
  const queuedAt = claim.events[0]?.atMs ?? now;
  return (
    <>
      <p className="headline-stat">
        Place {claim.position} in line. {formatUsdc(claim.aheadAssets)} USDC ahead of you.
      </p>
      <p className="lead">Waiting {formatMs(Math.max(0, now - queuedAt))}. You will be paid automatically once repayments cover the requests ahead of you and yours.</p>
    </>
  );
}

export default function ClaimPage() {
  const params = useParams<{ id: string }>();
  const requestId = Number(params.id);
  const now = useNow();
  const wallet = useChainQuery((chain) => chain.getWallet(), "wallet");
  const claim = useChainQuery((chain) => chain.getClaim(requestId), `claim-${requestId}`);
  const quote = useChainQuery(
    (chain) => (claim.data?.status === "queued" ? chain.quoteWithdraw(claim.data.assets) : Promise.resolve(null)),
    `claim-quote-${requestId}-${claim.data?.status}`,
  );
  const cash = quote.data?.cashNow;

  return (
    <>
      <section className="hero">
        <p className="label">Request {Number.isFinite(requestId) ? requestId : ""} · {claim.data ? `${formatUsdc(claim.data.assets)} USDC` : "reading"}</p>
        {claim.loading && !claim.data && <p className="headline-stat"><span className="skeleton" /></p>}
        {claim.error && (
          <p className="error" role="alert">
            {claim.error} <button type="button" className="link-button" onClick={claim.reload}>Try again</button>
          </p>
        )}
        {!claim.loading && !claim.error && claim.data === null && (
          <>
            <p className="headline-stat">No such request in this wallet.</p>
            <p className="lead">
              Requests are listed per wallet. <Link href="/">Start a withdrawal</Link> to create one.
            </p>
          </>
        )}
        {claim.data && <Headline claim={claim.data} now={now} />}
      </section>

      {claim.data && (
        <div className="grid">
          <section className="panel" aria-label="What happened">
            <h2 className="label">What happened, in order</h2>
            <ol className="timeline">
              {claim.data.events.map((event, index) => (
                <li key={`${event.kind}-${index}`} className="done">
                  <div>
                    <p>{STEP_TEXT[event.kind]}</p>
                    <p className="when">
                      {event.atMs !== null && `${clock(event.atMs)} · `}
                      {NETWORK_TEXT[event.network]} · tx <TxLink hash={event.txHash} network={event.network} />
                    </p>
                  </div>
                </li>
              ))}
              {claim.data.status === "queued" && (
                <li>
                  <div>
                    <p>Waiting for a repayment</p>
                    <p className="when">Nothing for you to do. This page updates by itself.</p>
                  </div>
                </li>
              )}
            </ol>
            {getChain().isMock && <p className="muted">Sample data: these transaction hashes are simulated and do not exist on an explorer.</p>}
          </section>

          <section className="panel" aria-label="Your options">
            {claim.data.status === "queued" ? (
              <>
                <h2 className="label">Tired of waiting</h2>
                {cash?.available ? (
                  <dl className="rows" style={{ margin: "var(--space-4) 0" }}>
                    <div>
                      <dt>You give up</dt>
                      <dd>place {claim.data.position} in the queue</dd>
                    </div>
                    <div>
                      <dt>Back right away</dt>
                      <dd>{formatUsdc(cash.receive)} USDC</dd>
                    </div>
                    <div>
                      <dt>Fee to the pool</dt>
                      <dd>
                        {formatUsdc(cash.fee)} USDC ({formatBps(cash.feeBps)})
                      </dd>
                    </div>
                    <div>
                      <dt>Most you can lose</dt>
                      <dd>{formatUsdc(cash.fee)} USDC</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="empty">{cash ? cash.reason : "Reading the pool's price"}</p>
                )}
                <TxButton
                  label={cash?.available ? `Sell my place for ${formatUsdc(cash.receive)} USDC` : "Sell my place"}
                  wallet={wallet.data}
                  blocked={cash?.available ? null : "Not available right now."}
                  action={async (options) => {
                    await getChain().sellClaim(requestId, options);
                  }}
                />
                <p className="muted">
                  Want to see the automatic payout? <Link href="/demo">Send a repayment from the demo console</Link>.
                </p>
              </>
            ) : (
              <>
                <h2 className="label">Receipt</h2>
                <dl className="rows" style={{ margin: "var(--space-4) 0" }}>
                  <div>
                    <dt>Requested</dt>
                    <dd>{formatUsdc(claim.data.assets)} USDC</dd>
                  </div>
                  <div>
                    <dt>You received</dt>
                    <dd>{formatUsdc(claim.data.received ?? 0n)} USDC</dd>
                  </div>
                  <div>
                    <dt>Fee</dt>
                    <dd>{formatUsdc(claim.data.fee ?? 0n)} USDC</dd>
                  </div>
                  {claim.data.latencyMs !== null && (
                    <div>
                      <dt>Repayment to payout</dt>
                      <dd>{claim.data.latencyMs} ms</dd>
                    </div>
                  )}
                </dl>
                <Link className="btn btn-secondary" style={{ display: "grid", placeItems: "center", textDecoration: "none" }} href="/">
                  Make another withdrawal
                </Link>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
