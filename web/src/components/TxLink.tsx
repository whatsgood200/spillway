import { getChain, type Network } from "@/lib/chain";
import { EXPLORER } from "@/lib/chain/config";
import { shortHash } from "@/lib/format";

/** A transaction hash that links to its explorer. In the simulation the hash is not real, so it is plain text. */
export function TxLink({ hash, network }: { hash: string | null; network: Network }) {
  if (!hash) return <span>not found</span>;
  if (getChain().isMock) return <span>{shortHash(hash)}</span>;
  return (
    <a href={`${EXPLORER[network]}${hash}`} target="_blank" rel="noreferrer">
      {shortHash(hash)}
    </a>
  );
}
