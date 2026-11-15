"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getChain, type ChainAdapter } from "./chain";

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Reads from the chain adapter and re-reads whenever the adapter reports a change.
 * Old data stays on screen during a refresh so numbers do not flicker.
 */
export function useChainQuery<T>(read: (chain: ChainAdapter) => Promise<T>, key: string): Query<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const readRef = useRef(read);
  const latest = useRef(0);

  useEffect(() => {
    readRef.current = read;
  });

  const reload = useCallback(() => {
    const ticket = ++latest.current;
    readRef
      .current(getChain())
      .then((value) => {
        if (ticket !== latest.current) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (ticket !== latest.current) return;
        setError(cause instanceof Error ? cause.message : "Could not read from the network.");
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();
    return getChain().subscribe(reload);
  }, [reload, key]);

  return { data, error, loading, reload };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
