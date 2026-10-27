---
name: analyzing-heap-snapshots
description: Use when reading a V8 heap snapshot of a Hydranium server or the report `hydranium-cli analyze-heap` prints, when comparing two snapshots, or when estimating what a memory change would free.
---

# Analyzing heap snapshots

`hydranium-cli analyze-heap <snapshot>` prints a Markdown report; its `--help`
lists the flags, and the report's first section says how to read its columns.
What the report cannot tell you is the framework's retention structure: which
objects co-own an AST, so that removing one of them frees nothing. This skill
is the order to read the report in, and that structure.

1. **Know what the snapshot holds.** `hydranium-cli measure-memory --services
   <module> <workspace> --snapshot --snapshot-path <file>` builds a workspace
   headless and writes one; a running data server writes one through its
   `writeHeapSnapshot` diagnostics request. A headless build has no editor
   session and no diagram, so the holders those add are absent from it.
2. **Read cost from Exclusive retained.** Shallow is where bytes sit; Retained
   subtree overlaps and is never summed. A V8 bucket such as `string` or
   `array (backing)` shows little exclusive because a concept owns its bytes.
3. **Ask who co-owns a concept before saying what frees it.** Run
   `--holders '<concept>,…'`. A dominator of `synthetic (roots)` means no
   object below the GC roots owns the nodes alone. The referrers tell which
   case it is: several holders share them, so cutting one frees nothing, or a
   root holds them directly.
4. **Expect the AST to be co-owned.** Each of these holds AST nodes, and the
   heap edge names it:
   - the document, through `ParseResult.value`;
   - the CST, through `_astNode`;
   - every description, through `node`;
   - every resolved reference, through `_ref` and through the description in
     `_nodeDescription`, often from another document; a multi-reference holds
     its targets through `_items`;
   - in a GLSP session, the model state's `_sourceRoot`, the index's
     `idToSemanticNode`, and each operation command on the undo stack, through
     `trace`, `workingRoots`, `sourceRootAtOpen` and `writtenRoot`, until an
     undo or redo of that command replaces them.

   A `ReferenceDescription` in the index manager's `referenceIndex` holds URIs,
   paths and a segment, no AST.
5. **Read "Heaviest documents" as a ranking.** It counts what a document node
   exclusively owns and leaves out its descriptions, which the index co-owns.
   When its last editor closes, a document the file system provider can serve
   is rebuilt and stays in the workspace; any other is removed. Only removal
   drops its descriptions and, once its dependents relink and no diagram
   holds it, its AST.
6. **Know the lever that exists.** `CstResidencyService` sheds the CST of a
   closed, file-backed document only when constructed with the
   `shed-closed-when-idle` strategy. Shedding nulls `$cstNode` and
   `$refNode`, which frees the CST and the ranges and positions only the CST
   holds. A description's selection segment, once read, shares its node's
   cached `Range` and keeps it. A single-token CST node builds a new `Range`
   on every read, so the name and `referenceIndex` segments of single-token
   names hold their own copies. The AST and the descriptions stay.
7. **Check every claim against the code before stating it.** A holder in the
   report is a heap edge name; find the field with `git grep` in `packages/`
   or in `node_modules/langium/lib` before naming the class that owns it.
