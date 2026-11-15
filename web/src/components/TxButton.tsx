"use client";

import { useState } from "react";
import { getChain, type TxOptions, type WalletState } from "@/lib/chain";

type Phase = "idle" | "wallet" | "pending" | "failed";

interface Props {
  label: string;
  wallet: WalletState | undefined;
  /** Why the action cannot run yet, shown under the disabled button. */
  blocked?: string | null;
  secondary?: boolean;
  action: (options: TxOptions) => Promise<void>;
}

/**
 * One button for every money action. It walks the transaction lifecycle
 * (connect, switch network, confirm in wallet, wait for inclusion) and reports failures in plain words.
 */
export function TxButton({ label, wallet, blocked, secondary, action }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const busy = phase === "wallet" || phase === "pending";

  async function run(task: () => Promise<void>) {
    setMessage(null);
    try {
      await task();
      setPhase("idle");
    } catch (cause) {
      setPhase("failed");
      setMessage(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    }
  }

  let text = label;
  let onClick = () => run(() => action({ onPhase: setPhase }));
  let disabled = busy || Boolean(blocked);

  if (!wallet) {
    text = "Reading wallet";
    disabled = true;
  } else if (wallet.status === "disconnected") {
    text = "Connect wallet to continue";
    disabled = busy;
    onClick = () =>
      run(async () => {
        setPhase("wallet");
        await getChain().connect();
      });
  } else if (wallet.status === "wrong-network") {
    text = "Switch to Base Sepolia";
    disabled = busy;
    onClick = () =>
      run(async () => {
        setPhase("wallet");
        await getChain().switchNetwork();
      });
  }
  if (phase === "wallet") text = "Confirm in your wallet";
  if (phase === "pending") text = "Waiting for Base Sepolia";

  return (
    <div className="tx">
      <button type="button" className={secondary ? "btn btn-secondary" : "btn"} disabled={disabled} aria-busy={busy} onClick={onClick}>
        {text}
      </button>
      {blocked && wallet?.status === "connected" && !busy && <p className="tx-note">{blocked}</p>}
      {message && (
        <p className="tx-note tx-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
