# Browser hosting

Why the packages are split the way they are for a browser, and what the
neutrality gate does and does not promise. The adopter's steps are in
[Host in a browser](../../guides/host-in-a-browser.md).

## The packaging contract

Every head's `.` entry is free of `node:*` and is gated that way
(`scripts/check-neutral-bundles.mts`). Anything Node-only lives behind a `/node`
subpath, and a browser bundle must not import those. The rule is mechanical:
**`.` is portable, `/node` is server-only.**

It applies below the `.` entry too, and the gate covers more than the heads: the
portable client tiers (`@hydranium/protocol/client`, `/data`), the LSP head
(`@hydranium/core/lsp`), the Theia client packages, and the test-support surface
— `*/testing` holds the browser-neutral doubles while `*/testing/node` holds the
harnesses that need a real filesystem or a Node stream transport. The script's
`TARGETS` is the enumeration.

A few non-`/node` public subpaths are excluded on their merits — a harness with
no portable half to split off, a conformance slice that asserts with
`node:assert/strict` by design, a passthrough of an upstream Node-bound entry.
The reason for each is stated beside the exclusion list in the script: only
being named there separates a considered exclusion from an oversight, so
restating the list here would let a doc copy drift into claiming coverage the
gate does not give.

One head has a third spelling. `@hydranium/glsp-server/browser` is the mirror of
its `/node` twin, because GLSP's launcher, app module and readiness signal all
differ per platform. `.` stays free of both so it resolves under either
platform, and the lint config bans naming either from neutral code.

## The one bare `'path'` import

`@hydranium/core`'s workspace initialization imports bare `'path'`, not
`node:path`, so a bundler can point it at a POSIX shim. It is the only such
import on the portable surface, and only the headless seam that takes workspace
folders as filesystem-path strings reaches it; a browser host passes
`WorkspaceFolder` URIs through LSP `initialize` instead, so the aliased code
does not run. Aliasing `node:*` as well would trade a build error for a runtime
one, because at `platform: 'browser'` esbuild refuses to resolve a Node builtin
rather than shimming it.

## Ports, not the worker global

A port is typed so that passing the global fails in the adopter's build:
`BrowserGlspServerOptions.context` is a structural `MessagePort` whose member
set a `Worker` and a `DedicatedWorkerGlobalScope` do not satisfy. That check
fires where those names resolve, a worker compiled against `lib.webworker` or a
page against `lib.dom`, which is the adopter's project rather than
`@hydranium/glsp-server`, whose own `lib` resolves neither.

Upstream declares `WorkerLaunchOptions.context` as `Worker`, narrower than the
`MessagePort | Worker | DedicatedWorkerGlobalScope` its own reader accepts, so
the framework casts structurally on the way through. The cast is redundant and
kept on purpose: `Worker` does not resolve under the framework's `lib` either,
so `skipLibCheck` degrades the option, and the assignment would compile
without the cast, which would be type-checking by accident rather than by
contract.

A port reports no close: Chromium has no `close` event on `MessagePort`,
Firefox and WebKit have not committed to one, and
`BrowserMessageReader`/`BrowserMessageWriter` fire none. The port transport's
in-band close signal stands in for it. For a connection at its default
parallelism and message strategy, the close waits until that end's connection
has dispatched every message sent before the signal, under either
`vscode-jsonrpc` runtime, so a `closeSession` already sent still ends its
session as closed.

## Diagnostics default themselves

The data head's diagnostics requests need a process to inspect. The extension
point is `DataServerDiagnosticsProvider`, not `DataServer`. `package.json`'s
`browser` field selects the Node implementation on Node and a rejecting twin in
a browser bundle, the same mechanism `@eclipse-glsp/server` uses to swap its
builds, so a host supplies nothing; `DataServerOptions.diagnostics` exists to
override, not to be required. The browser twin throws rather than no-ops,
because an empty snapshot reads as a healthy server. In a browser these
measurements are taken from outside the page, over CDP, so an in-process API is
the wrong shape for them rather than an unfilled gap.

## Why persistence is a mirror

Langium's `FileSystemProvider` is half synchronous — `statSync`,
`readFileSync`, `existsSync`, `readDirectorySync` — and the workspace walk uses
them. `IndexedDB` has no synchronous API at all; OPFS has synchronous file
handles, only inside a worker, but enumerates a directory asynchronously. So
`PersistentFileSystemProvider` keeps the in-memory map as the read path and
mirrors writes to the store at the one `setFile` chokepoint, and
`persistentFileSystem` restores the store before the provider exists.

A deletion of a seeded path is stored as a marker, because a delta cannot
express absence by omission: dropping the stored entry would bring the seeded
content back on the next load. A path the seed never carried is removed
outright, so scratch files do not grow the store. The marker is a reserved
value rather than a reserved key, because a key is a path by contract and a
store may map keys to real filenames; a host reading the store directly sees
markers among the content.

## What "gated neutral" does and does not promise

`check:neutral` bundles each gated entry for the browser and fails on a
`node:*` import. Third-party dependencies are externalised, which is right,
since an unrelated package's Node code must not decide our verdict, but it
means nothing reads inside them. So the gate resolves `@hydranium/*` rather than
externalising it, which catches a portable entry reaching a sibling's `/node`
subpath, and classifies every externalised specifier by name as well, which
catches a package's `/node` subpath and a builtin spelled without its prefix,
with one importer-keyed exemption for the bare `'path'` above.

Both are regression-only, so the gate self-tests: one canary fixture per
detection path must be rejected on every run, and the gate reports itself
blind if one survives. A clean run is then evidence rather than an absence.

An adopter's own browser bundle is still the stricter check. It covers the
whole composition, and a gate that scopes itself to one package, or that stops
reading at a specifier it externalises, cannot see what happens at the seams.
