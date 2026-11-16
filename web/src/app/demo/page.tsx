"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { VaultPanel } from "@/components/VaultPanel";
import { getChain } from "@/lib/chain";
import { USDC, shortHash } from "@/lib/format";
import { useChainQuery } from "@/lib/useChain";

function DemoButton({ label, run, secondary }: { label: string; run: () => Promise<string | void>; secondary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  return (
    <div className="tx">
      <button
        type="button"
        className={secondary ? "btn btn-secondary" : "btn"}
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            const text = await run();
            setNote({ text: text ?? "Done.", failed: false });
          } catch (cause) {
            setNote({ text: cause instanceof Error ? cause.message : "That did not work. Try again.", failed: true });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working" : label}
      </button>
      {note && (
        <p className={`tx-note${note.failed ? " tx-error" : " good"}`} role={note.failed ? "alert" : "status"}>
          {note.text}
        </p>
      )}
    </div>
  );
}

export default function DemoPage() {
  const chain = getChain();
  const live = !chain.isMock;
  const wallet = useChainQuery((c) => c.getWallet(), "wallet");
  const connected = wallet.data?.status === "connected";
  const [demoAccount, setDemoAccount] = useState<string | null | undefined>(undefined);
  const [lastRequest, setLastRequest] = useState<number | null>(null);
  // Live amounts are small: the demo account runs on faucet dollars.
  const small = live ? 2n * USDC : 1_000n * USDC;
  const large = live ? 5n * USDC : 10_000n * USDC;
  const show = (amount: bigint) => (amount / USDC).toLocaleString("en-US");

  useEffect(() => {
    if (!live) return;
    fetch("/api/demo")
      .then((response) => response.json())
      .then((body: { data: { address: string | null } | null }) => setDemoAccount(body.data?.address ?? null))
      .catch(() => setDemoAccount(null));
  }, [live]);

  return (
    <>
      <section className="hero">
        <p className="label">Demo console</p>
        <h1>
          Make the borrower <em>repay</em>.
        </h1>
        <p className="lead">
          {live
            ? "No wallet needed. A demo account on Base Sepolia queues a withdrawal and then repays its loan. Watch Reactive Network pay the queue about a second later, with nobody calling the vault."
            : "These buttons act as the demo borrower, not as you. Join the queue on the Withdraw page first, then send a repayment here and watch your request get paid about a second later."}
        </p>
        {live && (
          <p className="muted">
            {demoAccount === undefined && "Reading the demo account."}
            {demoAccount === null && "The demo account is not configured on this server, so these buttons will not work."}
            {demoAccount && `Demo account ${shortHash(demoAccount)}. Its transactions are ours, made to show the flow. They are not user activity.`}
          </p>
        )}
      </section>

      <div className="grid">
        <div className="stack">
          <section className="panel" aria-label="Demo actions">
            <h2 className="label">{live ? "Step 1 · Put someone in the queue" : "Demo lender"}</h2>
            {!live && !connected && <p className="empty">Connect a wallet first, using the button at the top of the page.</p>}
            <div className="actions">
              <DemoButton
                label={`Queue a ${show(small)} USDC withdrawal`}
                run={async () => {
                  const { requestId } = await chain.demoQueueWithdrawal(small);
                  setLastRequest(requestId);
                  return requestId ? `Queued as request ${requestId}. The vault is now fully lent out.` : "Done.";
                }}
              />
            </div>
            {lastRequest !== null && (
              <p className="muted">
                <Link href={`/claim/${lastRequest}`}>Open request {lastRequest}</Link> to watch it get paid.
              </p>
            )}
            <p className="muted">The demo lender deposits, the demo borrower takes every dollar the market can release, and the lender then asks to withdraw. With no cash in the market, the request has to queue.</p>
          </section>

          <section className="panel" aria-label="Borrower actions">
            <h2 className="label">{live ? "Step 2 · Repay, and do nothing else" : "Demo borrower"}</h2>
            <div className="actions">
              <DemoButton label={`Repay ${show(small)} USDC`} run={() => chain.demoRepay(small)} />
              <DemoButton label={`Repay ${show(large)} USDC`} run={() => chain.demoRepay(large)} />
              <DemoButton label="Borrow all idle cash again" secondary run={() => chain.demoBorrowIdle()} />
            </div>
            <p className="muted">A repayment pays the queue from the front for as far as the cash goes. A request too large for what is left waits for the next repayment; nobody behind it jumps ahead.</p>
          </section>

          {!live && (
            <section className="panel" aria-label="Failure cases">
              <h2 className="label">Try the failure cases</h2>
              <div className="actions">
                <DemoButton label="Decline my next transaction" secondary run={() => chain.demoSetNextFailure("rejected")} />
                <DemoButton label="Revert my next transaction" secondary run={() => chain.demoSetNextFailure("reverted")} />
                <DemoButton label="Put my wallet on the wrong network" secondary run={() => chain.demoSetWrongNetwork(true)} />
                <DemoButton label="Start over with sample data" secondary run={() => chain.demoReset("seeded")} />
                <DemoButton label="Start over with an empty vault" secondary run={() => chain.demoReset("empty")} />
              </div>
              <p className="muted">Each failure applies once, to the next money action you take on any page.</p>
            </section>
          )}
        </div>

        <VaultPanel label="The vault right now" />
      </div>
    </>
  );
}
