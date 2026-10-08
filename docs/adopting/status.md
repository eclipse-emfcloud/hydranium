# Status and limitations

## Status: alpha

Hydranium publishes a prerelease to npm on every merge to `main`. The public API
is not frozen: names, module layout, service slots and DI bindings can change
between releases, without a deprecation window.

- **Use it if** you are willing to track the framework closely, pin each
  release exactly, and adapt your code when a seam moves.
- **Wait if** you need a stable dependency for a product on a fixed schedule.

It is alpha because the _surface_ is still moving, not because the _machinery_
is unproven: three protocol heads already run on one shared workspace.

## Stability and versioning

- **Pin exactly.** Every release is a prerelease, and no semver range matches a
  prerelease, so a range resolves none of them. Until the first stable release,
  a bare `npm install` gets the newest prerelease. Any release may break the
  API, and there is no changelog on this line.
- **Never mix versions.** All `@hydranium/*` packages are released together at
  one version, and several of them share types by identity rather than by
  structure.
- **Subpaths are surface too.** A subpath export such as `@hydranium/core/lsp`
  is as stable as the package root. A subpath ending in `/testing` is test
  support only and may change with no notice; do not import it from production
  code.
- **`protected` members are surface.** The framework is extended by
  subclassing, so `protected` members are held to the same bar as public ones.
  A `protected` member with no caller in the framework is a seam, not dead code.

## Known limitations

### The framework ships no translations

Every message is English until you supply a catalogue; the server then renders
diagnostics and messages in each client's locale.
[Translate your language](../guides/translate-your-language.md) shows how, and
what stays English: a string sent without a code, and client text the host
translates itself.

### Data-head updates are whole-document

`updateModelDocument` takes either a complete transfer-model root or the
complete serialized text. There is no incremental or patch-based update on the
data head: editing one attribute of a large model sends the whole model. The
same holds in the other direction: an update notification carries the whole
document, not a delta.

This is a throughput ceiling on very large models, not a correctness problem.
Conflict detection is version-based (`baseVersion`), so concurrent whole-model
updates are rejected rather than silently merged.

### Langium is pinned to one exact version

Hydranium requires a **single physical copy** of Langium in the dependency
graph, so the version is pinned exactly and the LSP wire stack beneath it moves
with it as one chain. **You cannot choose a different Langium version.** The
mechanism, the exact chain, and what your own manifest has to say are in
[Requirements](requirements.md).

It costs you in two places: a Langium release you want is a release you wait
for, and every change to the pin needs a from-scratch reinstall rather than a
lockfile refresh.

### Semantic tokens add no colour in Theia

Theia hands a server's semantic tokens to Monaco wherever the server runs, but
Monaco does not colour them. Theia loads a theme's `tokenColors` and drops its
`semanticHighlighting` and `semanticTokenColors`, so under the default
`editor.semanticHighlighting.enabled` value, `configuredByTheme`, semantic
highlighting stays off. Turning the setting on does not fix it: Monaco looks a
token's type up as a theme rule name, and Theia's themes name their rules by
TextMate scope. A type that happens to name a styled scope (`comment`,
`keyword`) takes that colour; every other type takes the editor's default
foreground. Syntactic (TextMate) highlighting still applies, and VS Code
colours the same tokens.

The framework cannot ship the colours, because the token types are each
language's own. A host can: the browser example turns the setting on and adds
theme rules named by its server's token types, in
[`monaco-lsp-adapter.ts`](../../examples/order-flow/browser/src/page/monaco-lsp-adapter.ts).

### Client libraries cover Theia only

The framework ships client-side wiring for **Theia**: a base every head shares,
a data-head client, and a GLSP client. There is no such library for VS Code or
for a plain browser page; both are shown in the examples, as code you copy
rather than a package you depend on. The protocol packages are host-neutral, so
writing a client for another host is supported.

### Persistence is text files on disk

The model is text on disk, parsed into a live AST. That is deliberate: files
stay human-readable, diffable and reviewable. It also means there is no
abstraction for a database, an object store, or a remote model repository. An
adopter that needs one supplies its own filesystem implementation.

### Unsaved edits are kept only so far

Unsaved edits live in the server's memory, and some ways of losing a client or
the server lose them:

- **A closing browser tab cannot wait for a save.** It can only ask the user
  before leaving.
- **A killed server loses the write it was making.** Nothing calls `fsync`
  either, so a power loss is not covered.
- **A page or worker that dies ends no session** when the heads talk over a
  `MessagePort`, which reports no end of its own. A language server in a worker
  keeps running after its page goes; only the editor's documents are closed.
- **A client that comes back after the release grace finds its documents
  reverted.** It writes its edits again where it can tell they still apply,
  and reports the rest as lost.
- **A restarted language server shows the editor's unsaved buffers as clean**
  to the diagram and data clients, while the editor still shows them dirty: an
  editor's first open counts its buffer as the file's text.
- **VS Code keeps an editor dirty after a server save** of the text it shows,
  and its next save writes the same bytes. Theia has `bindEditorDiskSync` for
  this, and VS Code has no counterpart.

### One process writes a workspace

**A workspace has a single writer, and that is a contract rather than an
oversight.** The framework serializes writes only _within_ one process. There
is no filesystem lock, so two processes over one workspace do not coordinate at
all: neither sees the other's writes queued, and the second write to land is
the one that stays on disk.

- Run one server process per workspace. Several heads sharing that process is
  the supported shape, and a second process writing the same directory is not.
- `hydranium-cli save` spawns its own data server, so running it against a
  workspace an editor already has open is two writers. Point it at a workspace
  nothing else is editing, or accept that the last write wins. The other
  subcommands only read.
- An adopter that needs writes from several processes has to coordinate them
  itself, above the framework.

What the framework does guarantee is that a file is not left half-written: a
write replaces the file whole, so a reader sees either the previous revision or
the new one. That prevents a torn file, not a lost write. Because the
replacement is a new file:

- a symlinked model file keeps its link, and the file it points at is replaced;
- permission bits carry over, but ownership, extended attributes and ACLs do
  not. Model files that depend on those have to be written through a filesystem
  provider of your own;
- a file with more than one hard link is the exception. It is written in place,
  so all its names see the new content and keep their ownership and
  attributes, but a reader that catches that write can see it half-done.

## Getting involved

Bug reports, questions and ideas are welcome on the
[issue tracker](https://github.com/eclipse-emfcloud/hydranium/issues), which is
also where planned work is tracked.
