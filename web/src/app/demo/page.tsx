"use client";

import { useState } from "react";
import { VaultPanel } from "@/components/VaultPanel";
import { getChain } from "@/lib/chain";
import { USDC } from "@/lib/format";
import { useChainQuery } from "@/lib/useChain";

function DemoButton({ label, run, secondary }: { label: string; run: () => Promise<void>; secondary?: boolean }) {
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
            await run();
            setNote({ text: "Done.", failed: false });
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
  const wallet = useChainQuery((c) => c.getWallet(), "wallet");
  const connected = wallet.data?.status === "connected";

  return (
    <>
      <section className="hero">
        <p className="label">Demo console</p>
        <h1>
          Make the borrower <em>repay</em>.
        </h1>
        <p className="lead">These buttons act as the demo borrower, not as you. Join the queue on the Withdraw page first, then send a repayment here and watch your request get paid about a second later.</p>
      </section>

      <div className="grid">
        <div className="stack">
          <section className="panel" aria-label="Borrower actions">
            <h2 className="label">Demo borrower</h2>
            {!connected && <p className="empty">Connect a wallet first, using the button at the top of the page.</p>}
            <div className="actions">
              <DemoButton label="Repay 3,000 USDC" run={() => chain.demoRepay(3000n * USDC)} />
              <DemoButton label="Repay 10,000 USDC" run={() => chain.demoRepay(10_000n * USDC)} />
              <DemoButton label="Borrow all idle cash again" secondary run={() => chain.demoBorrowIdle()} />
            </div>
            <p className="muted">A repayment pays the queue from the front for as far as the cash goes. A request too large for what is left waits for the next repayment; nobody behind it jumps ahead.</p>
          </section>

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
        </div>

        <VaultPanel label="The vault right now" />
      </div>
    </>
  );
}
