"use client";

import { formatUsdc, parseUsdc } from "@/lib/format";

interface Props {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The balance the presets are fractions of. */
  max: bigint | undefined;
  maxLabel: string;
}

export function AmountField({ id, label, value, onChange, max, maxLabel }: Props) {
  const preset = (numerator: bigint, denominator: bigint) => {
    if (max !== undefined) onChange(formatUsdc((max * numerator) / denominator).replace(/,/g, ""));
  };
  const invalid = value !== "" && parseUsdc(value) === null;
  return (
    <div className="amount">
      <label className="amount-label" htmlFor={id}>
        {label}
      </label>
      <div className="amount-row">
        <input
          id={id}
          className="amount-input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="amount-unit">USDC</span>
      </div>
      <div className="amount-foot">
        <span>{max === undefined ? "Connect a wallet to see your balance" : `${maxLabel}: ${formatUsdc(max)} USDC`}</span>
        <span className="chips">
          <button type="button" disabled={max === undefined} onClick={() => preset(1n, 4n)}>
            25%
          </button>
          <button type="button" disabled={max === undefined} onClick={() => preset(1n, 2n)}>
            50%
          </button>
          <button type="button" disabled={max === undefined} onClick={() => preset(1n, 1n)}>
            Max
          </button>
        </span>
      </div>
      {invalid && <p className="tx-note tx-error">Enter an amount like 1000 or 250.50.</p>}
    </div>
  );
}
