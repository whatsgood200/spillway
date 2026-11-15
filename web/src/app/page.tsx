"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AmountField } from "@/components/AmountField";
import { TxButton } from "@/components/TxButton";
import { VaultPanel } from "@/components/VaultPanel";
import { getChain, type TxOptions } from "@/lib/chain";
import { formatBps, formatUsdc, parseUsdc } from "@/lib/format";
import { useChainQuery } from "@/lib/useChain";

export default function WithdrawPage() {
  const router = useRouter();
  const [input, setInput] = useState("1000");
  const assets = parseUsdc(input);
  const wallet = useChainQuery((chain) => chain.getWallet(), "wallet");
  const quote = useChainQuery((chain) => (assets ? chain.quoteWithdraw(assets) : Promise.resolve(null)), `quote-${assets ?? "none"}`);
  const claims = useChainQuery((chain) => chain.getMyClaims(), "claims");

  const balance = wallet.data?.status === "connected" ? wallet.data.vaultBalance : undefined;
  const q = assets && quote.data && quote.data.assets === assets ? quote.data : null;
  const blocked = !assets
    ? "Enter an amount to withdraw."
    : balance !== undefined && assets > balance
      ? balance === 0n
        ? "You have nothing in the vault yet. Deposit first."
        : "That is more than you have in the vault."
      : null;

  async function queueThenMaybeSell(sell: boolean, options: TxOptions) {
    if (!assets) return;
    const chain = getChain();
    const { requestId, paidAtOnce } = await chain.requestRedeem(assets, options);
    if (sell && !paidAtOnce) await chain.sellClaim(requestId, options);
    router.push(`/claim/${requestId}`);
  }

  const open = claims.data?.filter((claim) => claim.status === "queued") ?? [];

  return (
    <>
      <section className="hero">
        <p className="label">01 · Withdraw from a full vault</p>
        <h1>
          Leave the queue <em>now</em>, or let it pay you.
        </h1>
        <p className="lead">
          When a lending vault is fully lent out, withdrawals wait in line. Sell your place to the pool for cash today, or keep it and be paid the second a repayment lands.
        </p>
      </section>

      <div className="grid">
        <section className="panel" aria-label="Your withdrawal">
          <h2 className="label">02 · Your withdrawal</h2>
          <AmountField id="withdraw-amount" label="Amount to withdraw" value={input} onChange={setInput} max={balance} maxLabel="In the vault" />

          {quote.error && (
            <p className="error" role="alert">
              {quote.error}
            </p>
          )}

          {q?.paidAtOnce ? (
            <div className="option primary">
              <h3>Paid at once</h3>
              <dl className="rows">
                <div>
                  <dt>You receive</dt>
                  <dd>{formatUsdc(q.assets)} USDC</dd>
                </div>
                <div>
                  <dt>Fee</dt>
                  <dd>0.00 USDC</dd>
                </div>
              </dl>
              <TxButton label={`Withdraw ${formatUsdc(q.assets)} USDC`} wallet={wallet.data} blocked={blocked} action={(options) => queueThenMaybeSell(false, options)} />
            </div>
          ) : (
            <div className="options">
              <div className="option primary">
                <h3>Cash now</h3>
                {q?.cashNow.available ? (
                  <dl className="rows">
                    <div>
                      <dt>You give up</dt>
                      <dd>place {q.position} in the queue</dd>
                    </div>
                    <div>
                      <dt>Back right away</dt>
                      <dd>{formatUsdc(q.cashNow.receive)} USDC</dd>
                    </div>
                    <div>
                      <dt>Fee to the pool</dt>
                      <dd>
                        {formatUsdc(q.cashNow.fee)} USDC ({formatBps(q.cashNow.feeBps)})
                      </dd>
                    </div>
                    <div>
                      <dt>Most you can lose</dt>
                      <dd>{formatUsdc(q.cashNow.fee)} USDC</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="empty">{q && !q.cashNow.available ? q.cashNow.reason : assets ? "Reading the pool's price" : "Enter an amount to see the price."}</p>
                )}
                <TxButton
                  label={q?.cashNow.available ? `Get ${formatUsdc(q.cashNow.receive)} USDC now` : "Get cash now"}
                  wallet={wallet.data}
                  blocked={blocked ?? (q && !q.cashNow.available ? "Not available for this amount." : !q ? "Reading the price." : null)}
                  action={(options) => queueThenMaybeSell(true, options)}
                />
              </div>
              <div className="option">
                <h3>Wait in line</h3>
                {q ? (
                  <dl className="rows">
                    <div>
                      <dt>Your place</dt>
                      <dd>{q.position}</dd>
                    </div>
                    <div>
                      <dt>Ahead of you</dt>
                      <dd>{formatUsdc(q.aheadAssets)} USDC</dd>
                    </div>
                    <div>
                      <dt>You receive</dt>
                      <dd>{formatUsdc(q.assets)} USDC</dd>
                    </div>
                    <div>
                      <dt>Paid</dt>
                      <dd>when repayments arrive</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="empty">{assets ? "Reading the queue" : "Enter an amount to see your place."}</p>
                )}
                <TxButton
                  label={q ? `Join the queue at place ${q.position}` : "Join the queue"}
                  wallet={wallet.data}
                  blocked={blocked ?? (!q ? "Reading the queue." : null)}
                  secondary
                  action={(options) => queueThenMaybeSell(false, options)}
                />
              </div>
            </div>
          )}

          <p className="muted">
            Cash now takes two confirmations: one to join the queue, one to sell your place. The fee rises as the pool empties. Queue payouts depend on borrowers repaying; nobody can
            promise when.
          </p>

          {open.length > 0 && (
            <p className="muted">
              You are waiting on{" "}
              {open.map((claim, index) => (
                <span key={claim.requestId}>
                  {index > 0 && ", "}
                  <Link href={`/claim/${claim.requestId}`}>
                    request {claim.requestId} ({formatUsdc(claim.assets)} USDC)
                  </Link>
                </span>
              ))}
              .
            </p>
          )}
        </section>

        <VaultPanel label="03 · The line right now" />
      </div>
    </>
  );
}
