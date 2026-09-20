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
and routes it by how the document is held. For a document open in an editor it
rides the current build. For a closed one it goes to disk in `'silent'` sync
mode, or to a staging slot the next open consumes in `'editor'` mode. Only the
disk write comes back through a re-parse, because Langium's factory gates
re-parsing on the CST's own `fullText`: with the repair staged rather than
written, the text the factory re-reads still matches the CST, the parse is
skipped, and the mutated AST stands against unrepaired text.

So for a closed document with a staged repair, layer 1 mirrors **disk** while
layer 2's AST carries the repair. `IntegrityService.SettledState` is the
landmark for post-integrity content, and what it guarantees is the AST: read a
repair from `parseResult.value`, or from the staged content, never from
`textDocument.getText()`. Layers 3 and 4 both project the AST, so both carry
the repair — only a consumer reading the raw text sees the older state.

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
caller passes it back as `TransferUpdateArgs.baseVersion` / `TransferSaveArgs.baseVersion`
to opt into the conflict gate. It is a server-owned counter that advances iff
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

## Choosing a capture instant

A based-on version is only meaningful relative to the moment the content was
read. Two write styles are in play, and they read at different moments:

- **Snapshot-diff** — project the model, edit the projection, write the result.
  The capture instant is when the projection was taken, because that is the state
  the edit is expressed against. `ReconcilingMultiDocumentGlspState` works this
  way: it captures a baseline at `setSourceRoot` and diffs against it.
- **Live-AST** — resolve a node, mutate it in place, write the document it
  belongs to. The capture instant is when the document was *read*, immediately
  before mutating, because that is the content the mutation assumed.

The rule for both: **read the version at the same instant you read the content,
and hold it.** Getting this wrong has one dominant failure shape, and it does not
announce itself.

<!-- snippet-skip: contrasting fragments shown outside any enclosing method -->

```ts
// Wrong: `document.textDocument` IS the live store object the gate reads, so a
// version taken here is compared against itself and the gate never fires.
mutate(document.parseResult.value);
await modelService.save({ uri, model: document.parseResult.value, clientId, baseVersion: document.textDocument.version });

// Right: read the version into a local before mutating, then pass that local.
const baseVersion = document.textDocument.version;
mutate(document.parseResult.value);
await modelService.save({ uri, model: document.parseResult.value, clientId, baseVersion });
```

The two differ by one line and by everything else. `document.textDocument` is
the server's own live object, not a copy taken when you read — so a version
pulled off it at write time is whatever the server is at *now*, which is the
number the gate is about to compare against. It matches by construction. The
local, captured next to the read, cannot drift.

Nothing in the type system distinguishes the two, because both are a `number`
off the same expression. Reviewing for it means asking *when* the read happened,
not whether a version was passed.

A gate that never fires looks identical to a gate that found no conflict: the
write succeeds, nothing is logged, and the concurrent edit it overwrote is simply
gone. Test it by advancing the document between the capture and the write and
asserting a `ConflictError`, not by observing that ordinary writes succeed.

## A transfer write does not preserve comments or formatting

Follow the table one more step. A form editor's field edit reaches the server as
a transfer model, and the only route back to text is *AST or transfer → text* —
the serializer, which emits the whole document from the model. So **the file is
rewritten, not patched**: every comment is dropped and every line is re-emitted
in the serializer's own layout. Editing one string field of a `.process` root
costs the file its explanatory header and re-wraps every task.

This is a property of the layer boundary, not a serializer bug. The transfer
model has no trivia channel — comments and whitespace live in the CST, which
`TransferEncoder` does not project and the wire shape has no slot for — so there
is nothing for the encode side to round-trip. A serializer cannot re-emit what it
was never given.

**Tell your users.** Two consequences an adopter has to decide about rather than
discover:

- A document that a form/diagram client can write is a document whose comments
  are transient. If your language's users keep meaning in comments, say so at the
  point they open the form, not in a changelog.
- A text editor and a form editor over the same file is still the supported
  shape — the LSP head mirrors the rewritten text straight back into the open
  editor — but the diff a user sees after one field edit is the whole file.

The narrower alternative, if you need it, is not a serializer change: it is a
write path that computes text edits over the changed nodes' CST ranges and
re-serializes only on a structural change. The framework does not do that today.

## Where an adopter's alias belongs

An adopter usually wants its own names rather than repeating the generics.
Both envelopes are plain generic interfaces, so an alias is all that is
needed:

```ts
type MyAstDocument = AstDocument<MyRoot, MyDiagnostic>;
type MyTransferDocument = TransferDocument<MyTransferRoot, MyDiagnostic>;
```

Two rules keep aliases from re-creating the confusion this doc removes:

1. **Alias each layer separately.** One alias covering "the document" pushes
   the AST-vs-transfer decision back to the call site.
2. **Keep the layer in the name.** An alias called `MyDocument` reads as
   whichever layer the reader last had in mind.

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
