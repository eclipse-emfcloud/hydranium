---
name: Bug report
about: Something in the framework behaves differently from what it documents
title: ''
labels: bug
assignees: ''
---

**Do not use this for security vulnerabilities.** See [`SECURITY.md`](../../SECURITY.md).

## What happened

<!-- What you saw, including the exact error text if there was one. -->

## What you expected

<!-- And, where it applies, which doc or doc comment led you to expect it. -->

## Reproduction

<!--
Steps, or a minimal grammar plus the smallest model file that shows it.
A failing test against `examples/order-flow` or a fresh `hydranium-cli init`
scaffold is the fastest thing for us to act on.
-->

## Versions

- Node:
- npm:
- `@hydranium/*`:
- Langium:

## Which head

<!-- LSP, data server, GLSP, the CLI, or a Theia client package. -->

## Anything already ruled out

<!--
Optional, and genuinely useful. Two failure modes account for a lot of reports
and are described in `docs/adopting/troubleshooting.md`: two physical copies of `langium`
or of `vscode-jsonrpc` in the install (identity checks silently answer `false`),
and a `moduleResolution` that cannot read an `exports` map. If you have checked
either, say so — it saves a round trip.
-->
