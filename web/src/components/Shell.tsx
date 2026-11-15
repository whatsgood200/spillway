"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getChain } from "@/lib/chain";
import { useChainQuery } from "@/lib/useChain";
import { formatUsdc, shortHash } from "@/lib/format";

const NAV = [
  { href: "/", label: "Withdraw" },
  { href: "/deposit", label: "Deposit" },
  { href: "/pool", label: "Pool" },
  { href: "/latency", label: "Latency" },
  { href: "/demo", label: "Demo" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const wallet = useChainQuery((chain) => chain.getWallet(), "wallet");
  const chain = getChain();
  const state = wallet.data;

  return (
    <>
      {chain.isMock && (
        <p className="banner">
          Sample data. This preview runs on a simulation, not on a chain. <Link href="/demo">Open the demo console</Link>
        </p>
      )}
      <header className="bar">
        <nav className="nav" aria-label="Main">
          <Link href="/" className="brand">
            Spillway
          </Link>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="status">
          <span>Base Sepolia testnet · chain 84532</span>
          {!state && <span>Reading wallet</span>}
          {state?.status === "disconnected" && (
            <button type="button" className="link-button" onClick={() => chain.connect()}>
              Connect wallet
            </button>
          )}
          {state?.status === "wrong-network" && (
            <button type="button" className="link-button warn" onClick={() => chain.switchNetwork()}>
              Wrong network · switch
            </button>
          )}
          {state?.status === "connected" && (
            <button type="button" className="link-button" title="Disconnect" onClick={() => chain.disconnect()}>
              {shortHash(state.address)} · {formatUsdc(state.usdc)} USDC
            </button>
          )}
        </div>
      </header>
      <main className="wrap">{children}</main>
      <footer className="foot wrap">
        <span>Unaudited testnet software. Testnet funds only.</span>
        <span>Built on Reactive Network and Morpho Blue.</span>
      </footer>
    </>
  );
}
