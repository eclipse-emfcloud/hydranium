---
name: analyzing-heap-snapshots
description: Use when reading a V8 heap snapshot of a Hydranium server or the report `hydranium-cli analyze-heap` prints, when comparing two snapshots, or when estimating what a memory change would free.
---

# Analyzing heap snapshots

Read the canonical
[heap ownership reference](../../../skills/hydranium-profiling/references/heap.md)
for report columns, shared ownership, server and renderer lifecycles, and
snapshot comparisons. It ships with the adopter skill so both audiences use
the same retention model.

For framework investigations, verify holder edge names in `packages/` or
`node_modules/langium/lib`.

`CstResidencyService` sheds the CST of a closed, file-backed document only with
`shed-closed-when-idle`, and only when `canShed` and `isSheddable` admit it.
Shedding nulls `$cstNode` and `$refNode`; the AST and descriptions stay. A
node description's selection segment, once read, shares the node's cached
`Range` and keeps it. A leaf CST node creates a new `Range` on each read, so
single-token name and reference-index segments can hold separate copies.
Check the captured version's getters before estimating the saving from sharing
those ranges.
