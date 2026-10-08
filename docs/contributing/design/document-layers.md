# Document layers: design

The rationale and internal mechanics behind the four document layers; the
adopter's view is in [The four document
layers](../../concepts/document-layers.md).

## Why `AstDocument` and `TransferDocument` are not one type

`AstDocument` and `TransferDocument.model` carry the same model: `version`,
`root`, `diagnostics`. They stay two types because the generic constraint is
the point: `TAst extends AstNode` and `TTransfer extends TransferElement` stop
an AST root from being handed to a wire method, and a transfer root from being
handed to something expecting resolvable references. A shared umbrella type
would have to relax to the union of both, and the two roots are exactly what
must never be confused. An AST root cannot be serialized to JSON, because its
containment links are cyclic and its `Reference<T>` objects are resolution
machinery, not data.

The duplication surfaces the AST-vs-transfer distinction at every declaration
site, which is where an author would otherwise reach for the wrong one. The
diagnostic parameter is split for the same reason: an `AstDiagnostic` is an
LSP `Diagnostic` whose `message` needs `Diagnostic.getMessageString`, while a
transfer diagnostic carries plain text.

## Why there is no transfer-to-AST decoder

The translation is one-directional by design. Transfer is lossy with respect
to `$container`, `$cstNode` and `Reference<T>` resolution, so going backwards
means restoring containment and resolving every reference against a scope,
which is what the parser and the linker already do. The parser is the
decoder; a direct converter would be a second, weaker implementation of scope
resolution.

## The two transfer modes, and why `'grammar'` is the one diffed

`TransferEncoder.toTransfer` emits one of two shapes, and the choice is a
correctness decision rather than a filter.

| Mode | Contains | For |
| --- | --- | --- |
| `'full'` | every own property, including computed scalars and synthetic child mirrors | the wire shape clients consume |
| `'grammar'` | only the grammar-declared properties, each carrying the node's own authored value | the base a write diffs and a serializer round-trips |

`'grammar'` is the authored state, what the document actually declares, which
is what makes it safe to diff two of them and persist the result. Two
mechanisms deliver that, and both matter: the key set comes from the
reflection allowlist, so no computed key appears; and the walk reads each
value straight off the node rather than through the `resolvePropertyValue`
hook, so no computed value appears under a declared key either.

The second half constrains any extension of the encoder.
`resolvePropertyValue` substitutes derived values, such as an
inheritance-resolved field, and is called in `'full'` mode only. Applied to
`'grammar'`, it would leave that shape diffable but no longer authored: a
property inherited from elsewhere would diff as a local edit whenever its
source moves, and a forward-write reconcile would measure the user's intent
against a base the document never contained.

## Text authority during a build

The shared text store is `HydraniumTextDocuments`, keyed by canonical URI. Its
server-owned content version
([Versions](../../concepts/document-layers.md#versions)) is distinct from the
version an LSP client declares for its own buffer. A language-client shadow
records the client-facing URI and the buffer an outbound edit is calculated
against; it is delivery state, never a source for parsing.

### How an integrity repair is routed

A rule mutates the AST in place; the integrity tier serialises the result and
commits it into the store only if the store still holds the text that
produced the AST, then reconciles the registered document. The route then
depends on who holds the URI:

- **An editor:** the settled listener sends the corrected content as a
  `workspace/applyEdit`. Disk is not written under an open editor.
- **Only the data or GLSP head:** the repair stays in the store and never
  stages. In `'silent'` mode it also goes to disk when disk still holds the
  text it was computed from and the store still holds the repair, so unsaved
  updates never ride along. Those heads mark only their own edits unsaved, so
  without that write a repair of text they never changed would leave store
  and disk apart with nothing showing it.
- **No client:** the repair goes to disk in `'silent'` mode, or to a staging
  slot in `'editor'` mode. Langium's factory may then skip the re-parse,
  because the CST's `fullText` still equals the disk text, so layer 1 mirrors
  disk while the AST carries the repair until a first open consumes the
  stage. `IntegrityService.SettledState` guarantees the AST, not the text.

### Transitions that change the owner

- **First `didOpen`** creates the shared entry from staged content, if any,
  otherwise from the client's declared text, and starts the editor shadow
  from the declared text; if another client holds the URI, the editor
  attaches to that entry instead. A document a build already parsed continues
  its numbering, so a write based on that root cannot pass the gate over
  different text. A URI never built, held only by the builder's placeholder,
  or whose root records `STALE_VERSION` starts at the opener's version.
- **`didChange` or a data/GLSP update** changes shared text and drives a
  build. LSP versions gate only that client's own packets; the content
  sequence advances only when shared text changes.
- **Integrity repair** compares the AST's parsed source with the store before
  committing, so a stale repair cannot overwrite a newer edit.
- **Outbound `workspace/applyEdit`** uses the client's shadow and declared
  version. The build can settle while it is in flight, so settlement alone
  does not prove the editor applied it. A rejected edit invalidates the shadow
  for a position-independent retry.
- **Save and last close** are separate. `save` writes the store text through
  the file's disk queue, in call order. The last close removes the entry and
  shadow but keeps the content-version sequence; see [Last close and
  release](client-sessions.md#last-close-and-release).

## The version services

The text store's counter moves exactly when the shared text changes, never
goes back within one server lifetime, and survives a close, a reopen and the
file's deletion. It counts every document a build parsed, opened or not, so
neither an external change of a never-opened file nor a recreated file reuses
a version handed out for other text. Three services keep the text and model
sides apart:

- **The text store** is the text side: the counter, the open text, and each
  URI's `TextState`.
- **`ModelLedger`** is the model side: each root's `ModelVersion`, the text it
  was parsed from where the CST no longer holds that text, and which root is
  the builder's placeholder.
- **`VersionSyncService`** reconciles every model a producer reports with the
  store, decides whether a model is behind its text, and owns every recovery
  build, retrying a failed one once before giving up.

### Wait semantics

[Waiting for a current
model](../../concepts/document-layers.md#waiting-for-a-current-model) gives
each wait's contract. Beyond it:

- Both families re-queue a document the builder's last build left short of
  the state; `waitFor*` builds nothing else.
- A root with no recorded version counts as synced, since no build would ever
  record it.
- On a Node host the write-lock scope follows the async stack
  (`AsyncLocalStorage`), so a build's listeners, and async work they start
  even past the build, wait for the state alone. A browser host installs no
  scope, so a wait inside a listener waits for a build that cannot start.
- Until the state is reached, a syncing read rejects once a retried sync or
  re-queued build fails again, or the builder stops re-queuing a document its
  builds do not advance, so a build failing after the parse rejects it too.

### Replacing the factory, registry, integrity or residency service

A replacement has one obligation: report every model it produces to
`VersionSyncService.modelProduced(document, origin)`. A factory passes
`origin.version`, the store's version read before the parse; a producer whose
CST does not hold the text the model describes, such as an in-place repair,
passes that text as `origin.text`; a registry reports each document it
registers, with no `origin`. A residency service that sheds a CST produces no
model: it records the root's text with `ModelLedger.record` before shedding,
since reconciling would step a closed document's sequence.

A model nobody reported reads `UNRECORDED_VERSION`. Waits count it as synced,
so a read of it loses its freshness guarantee, and every write gated on its
version conflicts. `AstDocumentManager.toAstDocument` logs a warning when it
projects such a root, except the builder's placeholder.

### Lifecycle mechanics

A root records the store's version exactly when it was parsed from the
store's text at that version; one parsed from other text, the file read while
a client holds text of its own, records less and is handed to `syncTo`. The
builder's placeholder is never handed out and records no version, so a write
based on it conflicts. A recovery build is requested from a `WorkspaceLock`
read, so it queues behind the running build instead of cancelling it;
requests for one URI share a build, and a change still debounced is left to
the debounce's build. A wait behind its text wakes on `onDidRecordModel`,
since a `Parsed` phase listener would be skipped by a cancel right after the
parse; a cancel is not a failure.

## Why `baseVersion` is branded and required

A base version is only meaningful relative to the moment the content was read.
`ModelVersion` is a `number`, branded so the compiler can tell a version that
came out of a read apart from one read off the live store. Only readers mint it:
the envelope constructors, from the root's record, and the GLSP state, from the
root's record or, on a refetch, from the store's version read in the tick it
reads the text. So every read hands back a version that fits the field and every
live handle hands back one that does not; writing the correct thing is writing
less. A `TextVersion` names the text the server holds when it is read, which can
be newer than the model the write edited: the gate would pass and the write
overwrite the newer text with an edit of the older, with nothing logged.
`asModelVersion` keeps the escape hatch, typed out where a reviewer can see it.

`baseVersion` is required because an omitted gate is an absence no
type-level discriminator can see: among many writes, the one that lost the
field reads exactly like the others. Requiring it turns the omission into a
compile error and the opt-out, `'any'`, into a word someone chose.

## Comment preservation mechanics

What users see is in [A transfer write preserves comments, but not
layout](../../concepts/document-layers.md#a-transfer-write-preserves-comments-but-not-layout).

The `trivia` preservers work outside the serializer: they extract comments and
trailing whitespace from the document being overwritten and put them back into
the serializer's output, re-parsing it to locate anchors. No serializer has to
participate, and one that reaches its children through its own per-`$type`
emitters cannot silently skip a node. Where the serializer puts a commented
child inline, the preserver opens a line before it and verifies that the
re-parsed comment still belongs to that child.

The preserver drops a comment rather than guess. A rename is carried only
when one node of the same type and shape occupies the same parent slot, since
without edit provenance a delete and an otherwise identical insert there look
the same. So a list whose membership count is unchanged, or whose survivors
come back in a different relative order, reads as exchanged identifiers and
those members lose their comments. A write that renames a node and gives its
old name to another produces exactly the text of a plain insertion, so the
comment follows the name; only a caller recording the rename could tell, and
the transfer model has nowhere to put that. An integrity repair is unaffected,
since it writes in place and the comment is anchored to the node object; a
diagram gesture is affected, since it writes a working copy's transfer
projection. An `anchorKey` override does not carry a node across a rename,
which asks the `NameProvider` what changed.

The narrower alternative, text edits over the changed nodes' CST ranges with
re-serialization only on a structural change, is not implemented.

## Vocabulary

These four terms each own one axis. They are not interchangeable, and the
taxonomy only holds if they stay separate:

| Term | Means |
| --- | --- |
| `transport` | the physical message channel |
| `wire` | the JSON-RPC method-name namespace |
| `transfer` | the wire data shape (no `$container`, references as strings) |
| `ast` | the Langium parse tree |

Likewise for the two operations: `encode` is structure→structure (lossy,
one-way); `serialize` is structure→text.
