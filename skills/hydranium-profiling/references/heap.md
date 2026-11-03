# Heap ownership

Identify the process and lifecycle state first. `server-heap` is a server
snapshot; `browser-heap` is a renderer snapshot. A headless workspace has no
editor sessions, diagram history or DOM. A snapshot from an app after closing
an editor may still include workspace data and resources awaiting disposal.

Use `hydranium-cli analyze-heap <snapshot>` for the server and add `--renderer`
for the renderer. The analyzer requires optional memlab peers; follow the
installed command's help if they are missing. Prefer an existing
`server-memory-report` artifact before parsing a large snapshot again.

Read exclusive retained size for non-overlapping concept attribution. Shallow
size tells where bytes physically sit. Retained subtrees overlap and cannot be
summed. A large string or backing-array bucket with little exclusive size can
be data attributed to another concept, not a contradiction.

Before estimating savings, use `--holders` on the concept to inspect both
dominators and referrers. A node immediately dominated by GC roots may have
several independent owners. Removing one owner then frees nothing. Concept
totals are not a promise that deleting one field releases the whole concept.

## Server

Expect AST nodes to be co-owned by several holders:

- the document's `ParseResult.value`;
- the CST's `_astNode`;
- each node description's `node`;
- resolved references through `_ref` and `_nodeDescription`, including those
  from other documents; multi-references hold targets through `_items`;
- a GLSP model state's `_sourceRoot`, the index's `idToSemanticNode`, and undo
  commands through `trace`, `operationRoots`, `sourceRootAtOpen` and
  `writtenRoot`, until undo or redo replaces them.

Verify holder edge names against the captured version's installed source before
naming an owner; the adopter need not have the Hydranium repository checked out.

The reference index's reference descriptions carry locations, not the target
AST itself. Distinguish those from exported node descriptions with node links.
The report's heaviest-document list excludes data co-owned through indexes, so
it ranks exclusive ownership rather than the total cost of loading each file.

Closing the last editor does not necessarily unload a file-backed document:
it can remain in the workspace. CST shedding is a configurable policy, not a
general promise that closing an editor frees the AST. Check the configured
residency policy before interpreting a retained CST as a leak.

## Renderer

Use DOM and renderer vocabulary. Detached nodes deserve investigation when
retained across repeated equivalent open/close cycles; one detached node during
an update does not prove a leak. Inspect listener, widget and model ownership,
and wait for the lifecycle boundary that should dispose them before comparing.

Backing stores, editor models and caches can dominate the renderer independently
of server ASTs. JavaScript heap attribution also does not account for every byte
of process or GPU memory. Do not equate a snapshot's total with RSS.

## Comparisons

Compare snapshots at equivalent lifecycle and GC boundaries after repeated
operations. A leak hypothesis should name the growing population, a retaining
path, and the operation that should release it. Confirm the path changes after
a fix and that repeated-cycle growth stabilizes; a smaller single snapshot is
insufficient evidence.
