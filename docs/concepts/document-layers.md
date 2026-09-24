# The four document layers

A "document" means four different things in this framework, and they are
routinely confused — the confusion is what this doc exists to remove. Each
layer owns a different question: what the user typed, what Langium built from
it, what the server hands to in-process consumers, and what crosses the wire.

**How to read it.** The layers are listed outermost-in: bytes first, wire
shape last. The two the framework itself owns — `AstDocument` and
`TransferDocument` — are structural twins that are deliberately NOT the same
type; the section after the table explains why, because that is the decision
people try to undo.

## The layers

| # | Layer | Type | Owned by | Carries |
| --- | --- | --- | --- | --- |
| 1 | LSP text | `TextDocument` | `vscode-languageserver-textdocument` | the characters, plus a version counter |
| 2 | Langium build artifact | `LangiumDocument` | `langium` | the live parse result, CST, references, build state |
| 3 | AST-layer snapshot | `AstDocument<TAst, TDiagnostic>` | `@hydranium/core` | an AST root + diagnostics + version |
| 4 | Wire envelope | `TransferDocument<TTransfer, TDiagnostic>` | `@hydranium/protocol` | a transfer root + diagnostics + version |

Layers 1 and 2 are upstream: the framework consumes them and does not
redefine them. Layers 3 and 4 are the framework's own, and are where the
naming questions arise.

### Layer 1 can lag layer 2's AST

The two upstream layers are normally in step — `LangiumDocument.textDocument`
is the characters its AST was parsed from. An integrity repair breaks that on
one path, and it is worth knowing before you read a repair back.

A rule mutates the AST in place; the integrity tier then serialises the result
and routes it by how the document is held. It commits the repair into the
shared text store only if the store still contains the text that produced the
AST, then reconciles the registered Langium document by re-parsing or
re-linking. What happens next depends on whether an editor holds the URI, not
on whether anything holds it. Open in an editor, the settled listener sends it
the corrected content as a `workspace/applyEdit`. Not open in an editor — closed,
or held only through the data or GLSP head — the repair goes to disk in
`'silent'` sync mode, or to a staging slot in `'editor'` mode. A staged repair
is the exception: Langium's factory may skip re-parsing because the CST's
`fullText` still equals the disk text it re-reads, leaving the mutated AST
ahead of the text document until a first open consumes the stage — which, for
a URI another head still holds, none does.

So for a closed document with a staged repair, layer 1 mirrors **disk** while
layer 2's AST carries the repair. `IntegrityService.SettledState` is the
landmark for post-integrity content, and what it guarantees is the AST: read a
repair from `parseResult.value`, or from the staged content, never from
`textDocument.getText()`. Layers 3 and 4 both project the AST, so both carry
the repair — only a consumer reading the raw text sees the older state.

### Which text wins during a build

The shared text store is `HydraniumTextDocuments`; it is keyed by canonical
URI. Its *server-owned* content version is distinct from the version an LSP
client declares for its own buffer. A language-client shadow records the
client-facing URI and the buffer used to calculate an outbound edit. The shadow
is delivery state, not another source for parsing.

The build-side descriptions below apply after a successful
`IntegrityService.SettledState` phase. Client delivery may finish later.

| URI state | Text authority and writer | Registered Langium document at settle | Editor shadow and delivery |
| --- | --- | --- | --- |
| Closed file, no staged repair | Disk; a closed `'silent'` repair writes it. | A build reads disk and reconciles after a textual repair. There is no open store entry. | None. |
| Open in the language client | Shared store; `didChange`, server-authored updates, and current-source integrity repairs write it. Disk is not written under the open editor. | A textual repair commits by URI and reconciles text/CST with the store; the AST also has its derived state. | Based on the editor's declared buffer. The settled listener queues a shadow-based `workspace/applyEdit`. |
| Open only through data or GLSP | Shared store; `ModelService.update` and current-source repairs write it. `save` persists it, and so does a `'silent'` repair. | A textual repair reconciles against store text. In `'silent'` mode it also writes disk, unsaved updates included. In `'editor'` mode it stages content that no open consumes: an editor attaching joins the existing entry instead of taking the first-open path, and the last close discards the stage. | None until an editor attaches; an editor joining this existing store refreshes from its current content. |
| Separately constructed Langium document for an already-open URI | Existing shared store; the separate document is not a text authority. | Its AST can enter a build, but repair commits only if its CST source still matches the store. A stale mutation is abandoned and the registered document is reconciled from current text. | Follows the actual open holder, never the separate document's text object. |
| Closed file with an `'editor'`-mode staged repair | Disk remains persisted; pending content takes priority on the next first open. | The settled AST carries the repair, while `textDocument` and CST may still describe disk. | None while closed. First `didOpen` starts a shadow from the editor's declared buffer so the pending correction can be delivered. |

The transitions that change the owner are explicit:

- **First `didOpen`** creates the shared entry from pending content, if any,
  otherwise from the client's declared text. An editor shadow starts from the
  text the editor actually declared. If another client already holds the URI,
  the editor attaches to that entry and refreshes from its current content.
- **`didChange` or a data/GLSP update** changes shared text and drives a build.
  LSP versions gate only that client's incoming packets; the server's content
  sequence advances only when shared text changes. A server-authored update
  checks its `basedOn` version before installing a payload.
- **Integrity repair** compares the AST's parsed source with the current open
  store before committing. A stale repair cannot overwrite a newer edit, and
  reconciliation discards its obsolete AST mutation. A repair for a URI no
  editor holds follows the disk or staging route in the table.
- **Outbound `workspace/applyEdit`** uses the client's shadow and declared
  version, not the server's content version. The build can settle while this
  request is still in flight, so settlement alone does not prove the visible
  editor has applied the edit. A rejected edit invalidates the shadow for a
  position-independent retry.
- **Save and last close** are separate transitions. `save` persists the
  current store text. The last close removes the shared entry and editor
  shadow and retains the content-version sequence. A file URI then gets a
  disk-backed rebuild; the default close handler leaves non-file documents in
  the index for the adopter to manage.

The open-document repair tests in the order-flow example exercise the normal
and separately constructed paths in both sync modes, for a URI an editor
holds. The row for a URI held only through the data or GLSP head is reached
by no test with a real holder; the integrity unit tests stub the editor-open
check instead.

### Layer 3 — `AstDocument`, the in-process snapshot

`AstDocument<TAst extends AstNode, TDiagnostic>`
(`core/src/documents/ast-document-manager.ts`) is a **snapshot envelope**, not
a live handle. It pairs an AST root with the diagnostics and the text-document
version that root was read at. Its manager is `AstDocumentManager`.

It exists because a `LangiumDocument` is live and mutable — it advances
through build phases, its references resolve and re-resolve, its CST may be
shed. A consumer that wants "the model as of now, with the diagnostics that
went with it" needs a snapshot, and needs the version so it can later say
which state its edit was based on.

That version field is load-bearing rather than informational: an in-process
caller sends it straight back as `TransferUpdateArgs.basedOn` /
`TransferSaveArgs.basedOn` to arm the conflict gate. Its type is
`SnapshotVersion`, a branded `number`, so the field a write declares itself
based on can only be filled from a read. It is a server-owned counter that
advances iff
the content changes, which is what makes the gate sound — and an integrity
repair is one of those changes, so a snapshot taken before a repair is
genuinely stale rather than merely older.

### Layer 4 — `TransferDocument`, the wire envelope

`TransferDocument<TTransfer extends TransferElement, TDiagnostic>`
(`protocol/src/transfer-document.ts`) is the same shape one layer out: a root,
diagnostics, a version. The difference is the constraint. `TransferElement` is
the **transfer** shape — no `$container` back-references, cross-references as
strings — because an AST root cannot be serialized to JSON: its containment
links are cyclic and its `Reference<T>` objects are resolution machinery, not
data.

Its paired events are `TransferDocumentUpdatedEvent` /
`TransferDocumentSavedEvent` (`protocol/src/data/events.ts`), mirroring the
AST layer's `AstDocumentUpdatedEvent` / `AstDocumentSavedEvent`.

## Why 3 and 4 are not one type

`AstDocument` and `TransferDocument` have identical structure: `uri`,
`version`, `root`, `diagnostics`. Collapsing them into a single
`ModelDocument<TRoot, TDiagnostic>` was **proposed and rejected** (locked
2026-05-12).

The reason is that the generic constraint is the entire point. `TAst extends
AstNode` and `TTransfer extends TransferElement` are what stop an AST root
from being handed to a wire method, and a transfer root from being handed to
something expecting resolvable references. A shared umbrella type would have
to relax to the union of both, and the two roots are exactly what must never
be confused — they differ in cyclicity and in whether references are resolved.

So the duplication is deliberate: **the pair surfaces the AST-vs-transfer
distinction at every declaration site**, which is where an author would
otherwise reach for the wrong one.

## Crossing between them

The translation is **one-directional by design**.

| Direction | Mechanism |
| --- | --- |
| AST → transfer (structure) | `TransferEncoder.toTransfer*` (`core/src/langium/transfer/transfer-encoder.ts`) |
| AST or transfer → text | the per-language `Serializer` slot on the language module |
| transfer → AST | *no direct converter* — serialize to text, then re-parse |

There is no `decode` method, and the absence is intentional rather than
unimplemented. Going backwards means restoring `$container` links and
resolving every reference against a scope — which is what the parser and the
linker already do. **The parser is the decoder.** A direct transfer→AST
converter would be a second, weaker implementation of scope resolution.

The asymmetry follows from transfer being lossy with respect to `$container`,
`$cstNode` and `Reference<T>` resolution.

## The two transfer modes, and why `'grammar'` is the one you diff

`TransferEncoder.toTransfer` emits one of two shapes, and the choice is a
correctness decision rather than a filter.

| Mode | Contains | For |
| --- | --- | --- |
| `'full'` (default) | every own property, including computed scalars and synthetic child mirrors | the wire shape clients consume |
| `'grammar'` | only the grammar-declared properties, each carrying the node's own authored value | the baseline a write diffs and a serializer round-trips |

**`'grammar'` is defined by what it guarantees, not by what it omits.** It is the
*authored state* — what the document actually declares — which is what makes it
safe to diff two of them and persist the result. Two mechanisms deliver that, and
both matter: the key set comes from the reflection allowlist, so no computed
*key* appears; and the walk reads each value straight off the node rather than
through the `resolvePropertyValue` hook, so no computed *value* appears under a
declared key either.

That second half is the one worth knowing about if you extend the encoder.
`resolvePropertyValue` exists to substitute derived values — an
inheritance-resolved field, a preference-dependent label — and it is called in
`'full'` mode only. An override that also applied to `'grammar'` would leave that
shape diffable and acyclic but no longer authored, and the two consequences are
both silent: a property inherited from elsewhere diffs as a local edit whenever
its source moves, and a forward-write reconcile measures the user's intent
against a baseline the document never contained. The framework scopes the hook
for you; the thing to remember is *why* it is scoped, because the same reasoning
applies to any extension that reaches the grammar shape.

## What a write says it was based on

A based-on version is only meaningful relative to the moment the content was
read. Two write styles are in play, and they read at different moments:

- **Snapshot-diff** — project the model, edit the projection, write the result.
  The version to declare is the one the projection carried, because that is the
  state the edit is expressed against. `ReconcilingMultiDocumentGlspState` works
  this way: it takes a baseline at `setSourceRoot` and diffs against it.
- **Live-AST** — resolve a node, mutate it in place, write the document it
  belongs to. The version to declare is the one the *read* returned, immediately
  before mutating, because that is the content the mutation assumed.

The rule for both: **a write declares the version its read returned.** `basedOn`
enforces it in two steps.

Its type is `SnapshotVersion` — a `number`, branded so the compiler can tell a
version that came out of a read apart from one read off a live handle. Only the
envelope constructors mint it, so every snapshot read hands back a version that
already fits the field and every live handle hands back one that does not.
Writing the correct thing is therefore writing less:

<!-- snippet-skip: contrasting fragments shown outside any enclosing method -->

```ts
// Right: the version is the one the read returned, next to the read.
const snapshot = await modelService.validated(uri);
mutate(document.parseResult.value);
await modelService.save({ uri, model: document.parseResult.value, clientId, basedOn: snapshot.version });

// Explicitly ungated, for a write with no reader behind it.
await modelService.save({ uri, model, clientId, basedOn: 'anything' });
```

`document.textDocument.version` does not compile in that field. It is a plain
`number` read off the live store, so at write time it answers with the version
the gate is about to compare it against — the gate passes unconditionally and
the concurrent edit is gone with nothing logged. `asSnapshotVersion` will still
force it through, which is deliberate: the escape hatch stays, it just has to be
typed out where a reviewer can see it.

And `basedOn` is **required**. An omitted gate is an absence, so no type-level
discriminator can see it — a file of twenty writes hides the one that lost the
field, and it reads exactly like the other nineteen. Requiring it turns the
omission into a compile error and the opt-out into a word someone chose.

A gate that never fires looks identical to a gate that found no conflict: the
write succeeds, nothing is logged, and the concurrent edit it overwrote is simply
gone. Test it by advancing the document between the read and the write and
asserting a `ConflictError`, not by observing that ordinary writes succeed.

## A transfer write preserves comments, but not layout

Follow the table one more step. A form editor's field edit reaches the server as
a transfer model, and the only route back to text is *AST or transfer → text* —
the serializer, which emits the whole document from the model. So **the file is
rewritten, not patched**, and most lines come back in the serializer's own
layout. The comment preserver may open lines around inline syntax so comments
remain beside their nodes. Editing one string field of a `.process` root
re-wraps every task that was hand-wrapped differently.

Comments and the document's trailing whitespace do survive, because the write
path carries them separately. The `trivia` preservers extract them from the
document being overwritten and put them back into the serializer's output — the
comment preserver locating its anchors by re-parsing that output — so no
serializer has to participate, and one that reaches its children through its own
per-`$type` emitters cannot silently skip a node. Both are registered per
language by default; an empty registry is how preservation is switched off.

What it avoids where it can is guessing. A comment it cannot tie to one node is
dropped rather than placed somewhere the author did not write it: a node the
`NameProvider` gives no identity, two siblings sharing one, or an anchor the
write deleted. A transfer-model rename is carried when one node of the same
type and shape occupies the same parent slot in the rewritten document; an
ambiguous match is dropped. A delete followed by an otherwise identical insert
in that slot is indistinguishable from a rename without edit provenance.

Rearranging a list is where that bites. Without provenance, renaming members
in place and shifting them along produce the same evidence, so a list whose
membership count is unchanged, or whose surviving members come back in a
different relative order, is read as identifiers having been exchanged and
those members lose their comments. An insertion or a deletion that only shifts
what survives keeps them.

**One shape is beyond that reach, and a transfer-model client can reach it.** A
payload that renames a node and gives its old name to another node in the same
write produces exactly the text a plain insertion produces, with the same keys
and a node under the old name that is identical under either reading. The
comment follows the name, so it lands on a declaration its author never wrote
it on. No rule over the two documents separates the two writes; only a caller
recording which node it renamed could, and the transfer model has nowhere to
put that. An in-place write — an integrity repair, a diagram gesture — is not
affected, because there the comment is anchored to the node object itself.

Identity here is whatever `NameProviderOptions.nameProperties` names, so point
that at the real identifier wherever `name` is a display label. A grammar that
identifies some nodes outside the naming surface altogether — by a
cross-reference unique among its siblings, say — overrides `anchorKey` and gets
those captured and placed too, though not carried across a rename, which asks
the `NameProvider` what changed.
When the serializer puts a commented child inline, the preserver opens a line
before it and verifies that the re-parsed comment still belongs to that child.

**Tell your users.** Two consequences an adopter has to decide about rather than
discover:

- Layout is transient even though comments are not. If your language's users
  hand-format their files, a form or diagram write normalises that formatting.
- A text editor and a form editor over the same file is still the supported
  shape — the LSP head mirrors the rewritten text straight back into the open
  editor — but the diff a user sees after one field edit spans the file.

Normalising layout on demand rather than on every write is what
`textDocument/formatting` is for; bind Langium's `lsp.Formatter` slot. The
narrower alternative for the write itself, if you need it, is a path that
computes text edits over the changed nodes' CST ranges and re-serializes only on
a structural change. The framework does not do that today.

## Where an adopter's alias belongs

An adopter usually wants its own names rather than repeating the generics.
Both envelopes are plain generic interfaces, so an alias is all that is
needed:

```ts
type MyAstDocument = AstDocument<MyRoot, MyAstDiagnostic>;
type MyTransferDocument = TransferDocument<MyTransferRoot, MyTransferDiagnostic>;
```

Three rules keep aliases from re-creating the confusion this doc removes:

1. **Alias each layer separately.** One alias covering "the document" pushes
   the AST-vs-transfer decision back to the call site.
2. **Keep the layer in the name.** An alias called `MyDocument` reads as
   whichever layer the reader last had in mind.
3. **The diagnostic is per layer too.** `AstDocument` carries what the build
   left on the `LangiumDocument` — an `AstDiagnostic`, which is an LSP
   `Diagnostic` — while `TransferDocument` carries what
   `TransferEncoder.toTransferDiagnostic` produced. They share no field types:
   `severity` is LSP's numeric enum on one and a string union on the other, and
   `message` needs `Diagnostic.getMessageString` on the first and is plain text
   on the second. One alias for both is the mistake the two parameters exist to
   prevent, and `AstDocument`'s constraint now rejects it.

## Vocabulary

These four terms each own one axis. They are not interchangeable, and the
taxonomy only holds if they stay separate:

| Term | Means |
| --- | --- |
| `transport` | the physical message channel |
| `wire` | the JSON-RPC method-name namespace |
| `transfer` | the wire *data* shape (no `$container`, references as strings) |
| `ast` | the Langium parse tree |

Likewise for the two operations: **`encode`** is structure→structure (lossy,
one-way); **`serialize`** is structure→text.
