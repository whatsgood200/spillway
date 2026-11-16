"use client";

import { useState } from "react";
import { AmountField } from "@/components/AmountField";
import { TxButton } from "@/components/TxButton";
import { VaultPanel } from "@/components/VaultPanel";
import { getChain } from "@/lib/chain";
import { formatUsdc, parseUsdc } from "@/lib/format";
import { useChainQuery } from "@/lib/useChain";

export default function DepositPage() {
  const [input, setInput] = useState(getChain().isMock ? "500" : "2");
  const [done, setDone] = useState<bigint | null>(null);
  const assets = parseUsdc(input);
  const wallet = useChainQuery((chain) => chain.getWallet(), "wallet");
  const connected = wallet.data?.status === "connected" ? wallet.data : undefined;
  const blocked = !assets ? "Enter an amount to deposit." : connected && assets > connected.usdc ? "That is more USDC than your wallet holds." : null;

  return (
    <>
      <section className="hero">
        <p className="label">Deposit</p>
        <h1>
          Lend USDC, keep a fair <em>exit</em>.
        </h1>
        <p className="lead">Deposits are lent on one Morpho Blue market on Base Sepolia. When the vault is fully lent out, withdrawals queue in order and are paid automatically as borrowers repay.</p>
      </section>
      <div className="grid">
        <section className="panel" aria-label="Deposit">
          <h2 className="label">Your deposit</h2>
          <AmountField id="deposit-amount" label="Amount to deposit" value={input} onChange={setInput} max={connected?.usdc} maxLabel="In your wallet" />
          <dl className="rows" style={{ marginBottom: "var(--space-4)" }}>
            <div>
              <dt>You pay</dt>
              <dd>{assets ? formatUsdc(assets) : "0.00"} USDC</dd>
            </div>
            <div>
              <dt>In the vault after</dt>
              <dd>{formatUsdc((connected?.vaultBalance ?? 0n) + (assets ?? 0n))} USDC</dd>
            </div>
            <div>
              <dt>Most you can lose</dt>
              <dd>your deposit, if borrowers default</dd>
            </div>
          </dl>
          <TxButton
            label={assets ? `Deposit ${formatUsdc(assets)} USDC` : "Deposit"}
            wallet={wallet.data}
            blocked={blocked}
            action={async (options) => {
              if (!assets) return;
              setDone(null);
              await getChain().deposit(assets, options);
              setDone(assets);
            }}
          />
          {done !== null && (
            <p className="tx-note good" role="status">
              Deposited {formatUsdc(done)} USDC. Your vault balance is now {formatUsdc(connected?.vaultBalance ?? 0n)} USDC.
            </p>
          )}
          <p className="muted">Withdrawals are not guaranteed to be instant. Testnet funds only.</p>
        </section>
        <VaultPanel label="The vault right now" />
      </div>
    </>
  );
}
