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

The server renders every diagnostic, RPC error and message value it sends
through its `MessageRenderer`, in the locale the client declared at
`initialize`, and the framework ships no catalogue for it. To translate, bind a
subclass of `DefaultMessageRenderer` that overrides `translationsFor(locale)`
to return a catalogue keyed by message code; `examples/order-flow` does this in
one small class and a JSON file.

The framework's own messages are enumerable: `core`, `protocol`, `data-server`
and `glsp-server` each export a `./messages` subpath whose `collectMessages()`
returns every message with its code and English text, and
`@hydranium/protocol/testing` carries an audit that finds catalogue keys naming
no real code.

Two limits remain. **Not every user-facing string carries a code**: a string
the server sends other than as a diagnostic, an RPC error or a message value is
English whatever the locale. And **client-side
text is the host's**: command labels and widget text localize through the
host's own mechanism, which is why the browser example ships a page catalogue
of its own while its diagnostics arrive translated from the server.

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
