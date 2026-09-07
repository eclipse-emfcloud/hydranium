# Status, limitations and roadmap

## Status: alpha, pre-v0

Hydranium is under active development and is **not yet published to npm**. Every
package sits at version `0.0.0`. The public API is not frozen: names, module
layout, service slots and DI bindings can and do change between commits, without
a deprecation window.

What that means in practice:

- **Use it if** you are willing to track the framework closely, read the
  migration notes on every bump, and adapt your code when a seam moves.
- **Wait if** you need a stable dependency for a product on a fixed schedule.

The framework is not a toy: it runs three protocol heads on one shared workspace
in a shipping product today. It is "alpha" because the _surface_ is still
moving, not because the _machinery_ is unproven.

## Stability and versioning

- All `@hydranium/*` packages version **in lockstep** and are released together.
  Mixing versions across the set is unsupported — several of them share types by
  identity, not by structure.
- **The release line starts at `1.0.0`, and that number is not a stability
  claim.** Under `fixed` versioning plus caret peer ranges a `0.x` line cannot
  take a minor bump at all, so the version number cannot carry the alpha signal.
  An **npm dist-tag** carries it instead: releases publish under `alpha`, so ask
  for `@hydranium/core@alpha` rather than relying on a bare install. A **minor**
  bump may contain breaking changes for as long as the framework is alpha. Pin
  exactly, or expect to read a changelog. ("pre-v0" above names the un-frozen
  API surface, not the version number.) [`releasing.md`](../contributing/releasing.md) has the
  tag mechanics.
- Subpath exports (`@hydranium/core/lsp`, `@hydranium/core/node`,
  `@hydranium/protocol/data`, …) carry the same stability level as the package
  root. Subpaths ending in `/testing` are **test-support only** and may change
  with no notice at all — do not import them from production code.
- The framework's extensibility model is subclassing, so `protected` members are
  part of the surface an adopter binds to. They are held to the same
  compatibility bar as public ones. If you find a `protected` member with no
  in-repo caller, that is the seam working as designed, not dead code.

## Known limitations

### The framework hardcodes user-facing strings

There is **no internationalization layer**. Every user-visible string the
framework emits — command-palette labels, the diagram loading overlay,
diagnostic and error text — is an English literal in the source. There is no
message catalogue, no `localize()` call, and no DI slot an adopter can bind to
supply translations.

Some strings are overridable one at a time by subclassing (the diagram widget
exposes its label through a `protected` getter, for example), but there is no
central seam: translating a Hydranium-based tool today means overriding each
call site individually, and there is no way to enumerate them.

Closing this needs a message-catalogue service on the shared tree plus a sweep
of every literal, and it is a breaking change to several signatures. It is
planned, not scheduled.

### Data-head updates are whole-document

`updateModelDocument` takes either a complete transfer-model root or the
complete serialized text. There is no incremental or patch-based update on the
data head: editing one attribute of a large model sends the whole model. The
same holds in the other direction — an update notification carries the whole
document, not a delta.

This is a throughput ceiling on very large models, not a correctness problem.
Conflict detection is version-based (`baseVersion`), so concurrent whole-model
updates are rejected rather than silently merged.

### Langium is pinned to one exact version

Hydranium requires a **single physical copy** of Langium in the dependency
graph, so the version is pinned exactly and the LSP wire stack beneath it moves
with it as one chain. **You cannot choose a different Langium version**, and
that is the limitation — the mechanism, the exact chain, and what your own
manifest has to say are in [Requirements](requirements.md).

The cost lands in two places worth knowing about before you commit: a Langium
release you want is a release you wait for, and every change to the pin needs a
from-scratch reinstall rather than a lockfile refresh.

### Semantic tokens do not reach Monaco on a Theia plugin-host

When the language server runs inside a Theia plugin-host, LSP semantic tokens
arrive at the plugin-host but are not propagated on to Monaco, so semantic-token
highlighting is absent in that configuration. Syntactic (TextMate) highlighting
is unaffected. It works fully in VS Code, and in Theia when the server is
launched as a backend contribution rather than from the plugin-host.

This is an upstream gap, not fixable from the framework or from an adopter's
code. The server's semantic-tokens implementation is correct and is exercised by
the other hosts.

### Client libraries cover Theia only

The framework ships client-side wiring for **Theia** (a cross-head base, a
data-head client, and a GLSP client). There is no equivalent library for VS Code
or for a plain browser page: both are demonstrated in the examples, but the
wiring there is example code you copy rather than a package you depend on.

The protocol packages themselves are host-neutral and dependency-light, so
writing a client for another host is a supported thing to do — it is just not
something the framework does for you yet.

### Persistence is text files on disk

The model is text on disk, parsed into a live AST. That is a deliberate design
choice — files stay human-readable, diffable and reviewable — but it means there
is no abstraction for a database, an object store, or a remote model repository.
An adopter that needs one supplies its own filesystem implementation; the
framework does not define that seam.

### One process writes a workspace

**A workspace has a single writer, and that is a contract rather than an
oversight.** The framework serialises writes only *within* one process: the
workspace lock is Langium's in-process promise queue, and Hydranium extends it
to mark write scopes rather than to widen its reach. There is no filesystem
lock, so two processes over one workspace do not coordinate at all — neither
sees the other's queue, and the second write to land is simply the one that
stays on disk.

Consequences for an adopter:

- Run one server process per workspace. Several heads sharing that process is
  the supported shape — that is what the shared services tree is for — and a
  second process writing the same directory is not.
- `hydranium-cli save` spawns its own data server, so running it against a
  workspace an editor already has open is two writers. Point it at a workspace
  nothing else is editing, or accept that whichever write lands last wins. The
  other subcommands only read.
- An adopter that genuinely needs multi-process writes has to supply the
  coordination itself, above the framework.

**What the framework does guarantee, with one stated exception below, is that a
file is never left half-written.** The Node filesystem provider stages the
content beside the file it is replacing and renames it into place, so a
concurrent reader observes either the previous complete revision or the new one.
That removes the *torn* file — a model that
fails to parse — but it removes nothing else. It does not serialise the writers,
and it does not stop a write being **lost**: the two writes still race, and the
loser's content is replaced wholesale. Losing a write is the limitation above;
not tearing one is the guarantee.

Because the replacement is a new file rather than the old one rewritten, it
resolves symlinks first — a symlinked model file keeps its link, and what gets
replaced is the file it points at — and carries the previous permission bits
over. Ownership, extended attributes and ACLs are not carried over. An adopter
whose model files depend on any of those has to write them through its own
filesystem provider.

Additional **hard links** are the one case where the provider gives the
guarantee up rather than the property. A new file has a new inode, so every
other name pointing at the old one would keep the previous revision and nothing
would say so. So a file with more than one link is written **in place**
instead: all its names see the new content, and its ownership, extended
attributes and ACLs survive along with them — but that particular write is not
atomic, and a reader that catches it mid-write can still see a torn file. It is
the exposure everyone had before staging existed, narrowed to multiply-linked
files. Breaking a link happens on every write; tearing only happens under
contention.

### No generated API reference

Documentation is hand-written. The packages ship their sources, and the doc
comments in them are detailed and kept current, but there is no published API
reference site to browse. Reading the `.d.ts` or the source is the reference
today.

### Runtime requirements

The published packages declare a Node floor you cannot go under, and it is a
floor rather than a preference — [Requirements](requirements.md) gives the
version and the reason. Developing the framework itself needs the same one.

## Roadmap

Directions, in rough priority order. None of these is a dated commitment.

1. **First published release.** Get `@hydranium/*` onto npm under an alpha tag,
   with a changelog and a documented upgrade path, so adopters can consume it
   without a workspace link.
2. **Freeze the v0 surface.** Settle role names, member visibility and module
   layout, publish the list of what is covered by the compatibility promise, and
   start writing migration notes against it.
3. **Internationalization.** A message-catalogue service on the shared tree, and
   a sweep that routes every user-facing literal through it.
4. **Incremental data-head updates.** A patch-shaped update path alongside the
   whole-document one, so large models stop paying full serialization per edit.
5. **A generated API reference**, published alongside the docs, so the doc
   comments become browsable rather than grep-able.
6. **Broader client coverage.** Promote the VS Code and browser wiring from
   example code into supported packages, so a non-Theia host is a dependency
   rather than a copy-paste.
7. **Task-shaped guides per head**, to sit alongside the existing conceptual
   documentation — "add a data-server method", "make a diagram editable", "add a
   cross-document validation".

## Getting involved

Bug reports, questions and pull requests are welcome —
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) says how, and why a question is often
worth more than a patch while the surface is still moving.
