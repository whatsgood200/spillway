import { createMockAdapter } from "./mock";
import { createRealAdapter } from "./real";
import type { ChainAdapter } from "./types";

export * from "./types";

const mode = process.env.NEXT_PUBLIC_CHAIN_ADAPTER ?? "mock";

// A production deployment must never run on simulated data.
if (mode === "mock" && process.env.NODE_ENV === "production") {
  throw new Error("The mock chain adapter is selected in a production build. Set NEXT_PUBLIC_CHAIN_ADAPTER to the real adapter.");
}

let adapter: ChainAdapter | null = null;

export function getChain(): ChainAdapter {
  if (!adapter) {
    if (mode === "real") adapter = createRealAdapter();
    else if (mode === "mock") adapter = createMockAdapter();
    else throw new Error(`Unknown chain adapter "${mode}". Use "real" or "mock".`);
  }
  return adapter;
}
