<!-- The design brief and the chosen system for this project. Fill the brief in Phase 1, propose two or three directions in Phase 2, record Right's pick here, then build only from tokens.css. Baseline: ../../_research/2026-11-design-interface-study.md. Borrow patterns, never a look: do not default to the fonts or colours named in that study. -->

# Design: Spillway

## 1. Brief (before any pixels)

- User, device and situation: a lender whose vault is 100 percent lent out, on a phone or laptop, anxious, wanting their money.
- Their one goal on the main screen: decide between cash now for a fee and waiting in line, with every number visible before signing.
- Content in priority order, with real copy: amount; "Cash now" (back right away, fee, most you can lose); "Wait in line" (place, amount ahead, when paid); the line itself; vault level; measured payout latency with transaction links.
- Three words for the feel: plain, exact, calm.
- Avoid: trading-terminal noise, urgency tricks, anything that hides the fee.
- What makes this product's subject visually its own (the source of the one custom visual): the line of people waiting and the vault's level. A is the line as numbered tickets, B is the vault as a level gauge with a spill line, C is the line as a departures board.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Family | <paper and ink, or black and one colour> | <money, proof, infrastructure go paper; games, trading, live data go black> |
| Display face | <name> | <what character it gives> |
| Body face | <name>, 15 or 16px | |
| Mono face | <name> | labels, nav, numbers, addresses |
| Accent | <one colour, as a token> | used for the emphasized word, live status, the positive number |
| Corners | <sharp 0 to 4px, or full pill> | one rule for the whole product |
| Signature detail | <one repeated device: label marker, frame, grid> | |
| Hero visual | <the live data shown, and the one custom visual> | |

Directions offered to Right on 2026-11-15 (mockups in `design/directions/`): A Ledger (paper and ink, Fraunces serif, sharp corners, blue accent, queue as tickets); B Gauge (black and amber, Bricolage Grotesque, sharp corners, vault level gauge, millisecond loop table); C Board (cool grey and vermilion, condensed uppercase display, pill corners, queue as a departures board). Chosen: pending.

## 3. Rules for every screen

- Headline under ten words, states the consequence, one emphasized word. 52px or larger on desktop, negative tracking.
- A mono label above every section. Sections may be numbered.
- One obvious main action per screen. Buttons name the action ("Contribute 50 USDC"), never "Submit".
- The first screen shows live product data. No intro animation that delays the headline; respect reduced motion.
- Every number carries its unit, its source or date, and the network.
- Before any money action show, in these words: **You pay**, **Back right away**, **Most you can lose**, **Most you can make**.
- A risk line under the main button. A banner when the data shown is sample data.
- Offer Simple and Pro depths when the audience is mixed.
- Refusals and failures get a page of their own, with contract address, block and raw data.
- Loading, empty, error, disconnected and wrong network states on every screen. Empty states say what to do next.
- Phone first: thumb sized targets, strong contrast, visible focus, labelled fields.
- Banned: purple to blue gradients, glow, frosted glass, emoji as icons, rows of three identical cards, placeholder text.

## 4. Component inventory

| Component | Variants | Built | Notes |
|---|---|---|---|
| Button | primary, secondary, quiet | | one style each, from tokens |
| Section label | | | mono, uppercase, with the marker |
| Stat (big numeral) | with unit, change, source | | |
| Action ticket | amount, presets, outcome rows | | |
| Status bar | network, connection, block or date | | |
| Table | numeric columns right aligned | | |
| Receipt or evidence row | accepted, refused | | |
| Empty, loading, error | | | |

## 5. Self review before showing Right

Take screenshots at phone and desktop width and check, one fix at a time:
- [ ] Can a stranger say what it does from the first screen in five seconds?
- [ ] Is there exactly one accent, and is it rare?
- [ ] Does anything look generic, cluttered or hard to read? Prefer removing.
- [ ] Do all colours, sizes and radii come from tokens.css?
- [ ] Contrast, focus rings and tap targets pass.
