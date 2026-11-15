/**
 * The Spillway mark: a full reservoir on the left, its water going over the crest and down the chute.
 * Colours come from the design tokens so the mark follows the theme.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="3" fill="var(--ink)" />
      <path d="M5 10H11.5C17 10 15.5 20.5 23 20.5V23H5Z" fill="var(--accent)" />
      <path d="M5 10H11.5C17 10 15.5 20.5 23 20.5" fill="none" stroke="var(--on-ink)" strokeWidth="2.25" strokeLinecap="square" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">Spillway</span>
    </span>
  );
}
