import { createMockAdapter } from "./mock";
import type { ChainAdapter } from "./types";

export * from "./types";

const mode = process.env.NEXT_PUBLIC_CHAIN_ADAPTER ?? "mock";

// A production deployment must never run on simulated data. NEXT_PUBLIC_ALLOW_MOCK exists only for
// the Phase 2 preview and is removed when the real adapter lands in Phase 4.
if (mode === "mock" && process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_ALLOW_MOCK !== "phase-2-preview") {
  throw new Error("The mock chain adapter is selected in a production build. Set NEXT_PUBLIC_CHAIN_ADAPTER to the real adapter.");
}

let adapter: ChainAdapter | null = null;

export function getChain(): ChainAdapter {
  if (!adapter) {
    if (mode !== "mock") throw new Error(`Unknown chain adapter "${mode}". The real adapter is added in Phase 4.`);
    adapter = createMockAdapter();
  }
  return adapter;
}
