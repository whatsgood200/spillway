<!-- Each claim points at the line that enforces it, at the commit that last changed this file. Update line numbers at feature freeze and again before submitting. A claim with no line or test is removed, never left vague. -->

# Claims a judge can check in two minutes

Run `<test command>` to see the tests that pin these. The live tour is [JUDGES.md](../JUDGES.md).

## <Area one, for example: the price, the vault, the settlement>

| Claim | File | Line | Test or note |
|---|---|---|---|
| <Only X can do Y> | `<path>` | <n> | `<error name or test name>` |
| <A cannot happen before B> | `<path>` | <n> | |
| <There is no owner, pause or upgrade> | `<path>` | <n> | |

## <Area two>

| Claim | File | Line | Test or note |
|---|---|---|---|
| | | | |

## What refuses, and where

| Bad input or action | Refused by | File | Line |
|---|---|---|---|
| <replay> | <contract or service> | `<path>` | <n> |
| <stale or out of range data> | | | |
| <wrong sender, wrong chain> | | | |
