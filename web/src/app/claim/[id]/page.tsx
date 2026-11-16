"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TxButton } from "@/components/TxButton";
import { TxLink } from "@/components/TxLink";
import { getChain, type Claim, type ClaimEvent } from "@/lib/chain";
import { formatBps, formatMs, formatUsdc } from "@/lib/format";
import { useChainQuery, useNow } from "@/lib/useChain";

/** Who the page is talking about: the visitor, the labelled demo account, or someone else. */
type Subject = "you" | "demo" | "other";

const WHO: Record<Subject, { name: string; owner: string; object: string }> = {
  you: { name: "You", owner: "your", object: "you" },
  demo: { name: "The demo account", owner: "its", object: "it" },
  other: { name: "The requester", owner: "their", object: "them" },
};

function stepText(kind: ClaimEvent["kind"], subject: Subject): string {
  const who = WHO[subject];
  if (kind === "queued") return `${who.name} joined the queue`;
  if (kind === "sold") return `${who.name} sold ${who.owner} place to the pool`;
  if (kind === "liquidity") return "A repayment landed in the vault";
  if (kind === "reactive") return "Reactive Network saw it and called the vault";
  return "The vault paid this request";
}

const NETWORK_TEXT: Record<ClaimEvent["network"], string> = { "base-sepolia": "Base Sepolia", lasna: "Reactive Lasna" };

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function Headline({ claim, now, subject }: { claim: Claim; now: number; subject: Subject }) {
  const who = WHO[subject];
  const demoNote = subject === "demo" ? " This request was made by the demo account, from the demo console." : "";
  if (claim.status === "sold") {
    return (
      <>
        <p className="headline-stat">Paid {formatUsdc(claim.received ?? 0n)} USDC now.</p>
        <p className="lead">
          {who.name} sold {who.owner} place in the queue to the pool for a fee of {formatUsdc(claim.fee ?? 0n)} USDC. The pool now waits in that place and is repaid when the vault pays this request.
          {demoNote}
        </p>
      </>
    );
  }
  if (claim.status === "paid") {
    return (
      <>
        <p className="headline-stat">
          Paid {formatUsdc(claim.received ?? 0n)} USDC{claim.latencyMs ? `, ${formatMs(claim.latencyMs)} after a repayment landed.` : "."}
        </p>
        <p className="lead">
          {claim.latencyMs
            ? "No keeper and no click. The repayment itself triggered the payout through Reactive Network."
            : "Paid when the queue was settled; no Reactive loop record matches this payout."}
          {demoNote}
        </p>
      </>
    );
  }
  const queuedAt = claim.events[0]?.atMs ?? now;
  return (
    <>
      <p className="headline-stat">
        Place {claim.position} in line. {formatUsdc(claim.aheadAssets)} USDC ahead.
      </p>
      <p className="lead">
        Waiting {formatMs(Math.max(0, now - queuedAt))}. {who.name === "You" ? "You will" : `${who.name} will`} be paid automatically once repayments cover the requests ahead and this one.
        {demoNote}
      </p>
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
  const [demoAddress, setDemoAddress] = useState<string | null>(null);

  useEffect(() => {
    if (getChain().isMock) return;
    fetch("/api/demo")
      .then((response) => response.json())
      .then((body: { data: { address: string | null } | null }) => setDemoAddress(body.data?.address ?? null))
      .catch(() => setDemoAddress(null));
  }, []);

  const requester = claim.data?.requester?.toLowerCase() ?? null;
  const me = wallet.data && wallet.data.status !== "disconnected" ? wallet.data.address.toLowerCase() : null;
  // In the simulation every request is the visitor's own.
  const subject: Subject = getChain().isMock || (requester !== null && requester === me) ? "you" : requester !== null && requester === demoAddress?.toLowerCase() ? "demo" : "other";
  const mine = subject === "you";

  return (
    <>
      <section className="hero">
        <p className="label">Request {Number.isFinite(requestId) ? requestId : ""} · {claim.data ? `${formatUsdc(claim.data.assets)} USDC` : claim.data === null ? "not found" : "reading"}</p>
        {claim.loading && !claim.data && <p className="headline-stat"><span className="skeleton" /></p>}
        {claim.error && (
          <p className="error" role="alert">
            {claim.error} <button type="button" className="link-button" onClick={claim.reload}>Try again</button>
          </p>
        )}
        {!claim.loading && !claim.error && claim.data === null && (
          <>
            <p className="headline-stat">No such request yet.</p>
            <p className="lead">
              Requests are numbered from 1 as they are made. <Link href="/">Start a withdrawal</Link> or <Link href="/demo">use the demo console</Link> to create one.
            </p>
          </>
        )}
        {claim.data && <Headline claim={claim.data} now={now} subject={subject} />}
      </section>

      {claim.data && (
        <div className="grid">
          <section className="panel" aria-label="What happened">
            <h2 className="label">What happened, in order</h2>
            <ol className="timeline">
              {claim.data.events.map((event, index) => (
                <li key={`${event.kind}-${index}`} className="done">
                  <div>
                    <p>{stepText(event.kind, subject)}</p>
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
                    <p className="when">Nothing to do. This page updates by itself.</p>
                  </div>
                </li>
              )}
            </ol>
            {getChain().isMock && <p className="muted">Sample data: these transaction hashes are simulated and do not exist on an explorer.</p>}
          </section>

          <section className="panel" aria-label="Your options">
            {claim.data.status === "queued" && !mine ? (
              <>
                <h2 className="label">Waiting</h2>
                <p className="empty">Only the wallet that holds this place can sell it to the pool.</p>
                <p className="muted">
                  Want to see the automatic payout? <Link href="/demo">Send a repayment from the demo console</Link>.
                </p>
              </>
            ) : claim.data.status === "queued" ? (
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
                    <dt>{mine ? "You received" : "Received"}</dt>
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
