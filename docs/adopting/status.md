# Status and limitations

## Status: alpha

Every merge to `main` publishes a prerelease to npm. The public API is not
frozen: names, module layout, service slots and DI bindings can change between
releases, with no deprecation window.

- **Use it** if you can track the framework closely, pin each release exactly,
  and adapt your code when a seam moves.
- **Wait** if you need a stable dependency for a product on a fixed schedule.

Alpha describes the API surface, not the machinery: three protocol heads
already run on one shared workspace.

## Stability and versioning

- **Pin exactly.** Every release is a prerelease, any of them may break the
  API, and there is no changelog. A range would let npm move you to a newer
  prerelease, and a bare `npm install` gets the newest one.
- **Use one version for every `@hydranium/*` package.** They are released
  together, and several share types by identity, so mixed versions do not fit
  together.
- **Subpaths count as API.** A subpath such as `@hydranium/core/lsp` is as
  stable as the package root. A `testing` subpath, and any subpath under it, is
  test support that can change without notice; do not import it from
  production code.
- **`protected` members count as API.** You extend the framework by
  subclassing, so a `protected` member is held to the same bar as a public one,
  even when nothing in the framework calls it.

## Known limitations

### The framework ships no translations

Every message is English until you supply a catalogue. The server then renders
diagnostics and messages in each client's locale.
[Translate your language](../guides/translate-your-language.md) shows how, and
what stays English.

### Data-head updates are whole-document

`updateModelDocument` takes a complete transfer-model root or the complete
serialized text. Editing one attribute of a large model sends the whole model,
and an update notification carries the whole document back.

This limits throughput on very large models, not correctness. Each update
carries a `baseVersion`, so a concurrent update is rejected rather than
silently merged.

### Langium is pinned to one exact version

The framework needs a single physical copy of Langium in your install, so you
cannot choose a different Langium version. You wait for the framework to adopt
a Langium release, and every change to the pin needs a from-scratch reinstall.
[Requirements](requirements.md) says what your manifest declares.

### Semantic tokens add no colour in Theia

In Theia, your server's semantic tokens leave the text in the editor's default
colour, while VS Code colours them. TextMate highlighting still applies.

The cause is in Theia: its themes keep `tokenColors` and drop their semantic
token colours, and their rules are named by TextMate scope, while Monaco looks
up a semantic token by its type name. Turning on
`editor.semanticHighlighting.enabled` alone colours only the types that happen
to match a scope, such as `comment` or `keyword`.

The framework cannot ship the colours, because each language has its own token
types. Your host can: turn the setting on and add theme rules named by your
server's token types, as the browser example does in
[`monaco-lsp-adapter.ts`](../../examples/order-flow/browser/src/page/monaco-lsp-adapter.ts).

### Client libraries cover Theia only

The client packages target Theia. For VS Code or a plain browser page, copy the
client code from the order-flow example. The protocol packages are
host-neutral, so a client for another host is supported.

### Persistence is text files on disk

Your model is text on disk, parsed into a live AST, so files stay readable,
diffable and reviewable. There is no built-in support for a database, an object
store or a remote model repository. If you need one, supply your own filesystem
provider.

### Unsaved edits are kept only so far

Unsaved edits live in the server's memory. You lose some of them when:

- **A browser tab closes.** It cannot wait for a save; it can only ask the user
  before leaving.
- **The server is killed.** The write in progress is lost. Nothing calls
  `fsync`, so a power loss is not covered either.
- **A page or worker dies** while the heads talk over a `MessagePort`. A port
  reports no end, so no session ends. A language server in a worker keeps
  running after its page goes; only the editor's documents are closed.
- **A client returns after the release grace** (`releaseGraceMs`). Its
  documents have been reverted. It writes its edits again where it can tell
  they still apply, and reports the rest as lost.
- **The language server restarts.** The diagram and data clients then see the
  editor's unsaved buffers as clean, while the editor still shows them dirty.
- **The server saves text a VS Code editor shows.** VS Code keeps the editor
  dirty, and its next save writes the same bytes. In Theia,
  `bindEditorDiskSync` handles this; VS Code has no counterpart.

### One process writes a workspace

A workspace has a single writer by contract. The framework serializes writes
only within one process, and takes no filesystem lock. Two processes over one
workspace do not coordinate: the later write wins.

- Run one server process per workspace, with all its heads in that process.
- `hydranium-cli save` spawns its own data server. Run it only on a workspace
  nothing else is editing, or accept that the later write wins. The other
  subcommands only read.
- If you need writes from several processes, coordinate them yourself, above
  the framework.

A write never leaves a file half-written: it replaces the file whole, so a
reader sees the old revision or the new one. That prevents a torn file, not a
lost write. Because the replacement is a new file:

- a symlinked model file keeps its link, and its target is replaced;
- permission bits carry over, but ownership, extended attributes and ACLs do
  not. If your model files depend on those, write them through your own
  filesystem provider;
- a file with more than one hard link is written in place instead. All its
  names see the new content and keep their attributes, but a reader can catch
  that write half-done.

## Getting involved

Report bugs, ask questions and suggest ideas on the
[issue tracker](https://github.com/eclipse-emfcloud/hydranium/issues), which
also tracks planned work.
