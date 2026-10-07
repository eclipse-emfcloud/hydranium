# Requirements for a consuming project

What your own project has to satisfy before `@hydranium/*` will install and
compile. The single physical copy of Langium is the one that surprises people.

## Node 22.13 or newer

The published packages declare that floor in `engines.node`. It is not a
preference: the compiled CommonJS in the Theia client packages `require()`s the
ESM heads across a published package boundary, which Node supports unflagged
only from 22.13.

## npm 11.6 or newer, or `vitest` below 4.1

npm before 11.6, which includes every npm a Node 22 release bundles, crashes on
a fresh install that includes `vitest` 4.1 or later, with `Cannot read
properties of null (reading 'edgesOut')`
([npm/cli#8261](https://github.com/npm/cli/issues/8261)). `init` holds the
scaffold's `vitest` at `~4.0.18` so its first install works on Node 22. It
lifts the hold only in a workspace whose root `packageManager` declares npm 11.6
or later, and only when the npm running `init` is known to be 11.6 or later too,
since npm does not enforce `packageManager`. `init` learns that npm from the
user agent `npx` and `npm run` set, so run any other way, as a global binary or
through pnpm or yarn, it keeps the hold. Raise it once every npm that installs
your project is 11.6 or later.

## One physical copy of Langium, and the wire stack pinned under it

Hydranium re-exports Langium's types through a single chokepoint package, and
identity-sensitive checks — `instanceof` on an AST node, on a `URI` — break
silently when two copies are installed. Nothing throws; the checks just answer
`false`.

The version is therefore pinned exactly, and the LSP stack beneath it moves with
it. Each `vscode-languageserver-protocol` release pins its own `vscode-jsonrpc`
exactly:

```text
langium 4.3.1
  → vscode-languageserver ~10.0.1
    → vscode-languageserver-protocol 3.18.1 (exact) → vscode-jsonrpc 9.0.0
  → vscode-languageserver-protocol ~3.18.1
    → 3.18.2 → vscode-jsonrpc 9.0.1
    → 3.18.3 → vscode-jsonrpc 9.0.2
    → 3.18.4 → vscode-jsonrpc 9.0.3
```

Bump `langium` and the stack beneath it together. Downgrading `vscode-jsonrpc`
to `8.x` only adds a copy — see the section below.

The peer declarations follow the chain. `@hydranium/core` declares
`vscode-languageserver` at `~10.0.1` and `vscode-languageserver-protocol` at
`~3.18.1`, each admitting what `langium@4.3.1` itself admits; a range reaching
back past the 3.18 stack would admit a release on the `8.x` transport. Within
them, any protocol but `3.18.1` brings a second 9.x transport beside the one
`vscode-languageserver@10.0.1` uses, which is why `init` pins the protocol
exactly. Every head
declares `vscode-jsonrpc` at `^9.0.0`, so it shares the 9.x your install
resolves, down to the `9.0.0` that `vscode-languageserver@10.0.1` resolves, and
excludes `8.x`. Supplying something outside a range does not stop
the install — npm downgrades an unsatisfiable peer to a warning — but you get a
named `ERESOLVE` line that prints the required version beside the one it found.
Under `--strict-peer-deps` it is an error.
`vscode-languageserver-types` and `vscode-languageserver-textdocument` are
deliberately left on a caret: both declare no dependencies of their own and
expose structural APIs, so a duplicate of either pulls no transport in.

Pins take effect only on a **from-scratch install**. Deleting the
lockfile alone leaves stale nested copies behind:

```bash
rm -rf node_modules package-lock.json
npm install
```

**If you followed an earlier version of this page**, remove the
`vscode-jsonrpc` and `vscode-languageserver-protocol` entries from your root
`overrides`, and the `vscode-jsonrpc` patch with the `patch-package`
`postinstall` that applied it. Without the patch those overrides stop GLSP at
startup, since `@eclipse-glsp/protocol` requires `vscode-jsonrpc/browser`, and
they conflict with the versions `init` declares. Keep `langium` pinned, declare
`vscode-languageserver` `10.0.1`, `vscode-languageserver-protocol` `3.18.1` and
`vscode-jsonrpc` `9.0.0` as `init` does, and reinstall from scratch as above.

## A resolver that reads `exports`

Every head package declares `vscode-jsonrpc` as a peer dependency, and the
version is not really yours to choose: `langium@4.3.1` depends on
`vscode-languageserver-protocol@~3.18.1`, each release of which pins a 9.x of
`vscode-jsonrpc` exactly. Installing the framework installs a 9.x.

Every 9.x release ships an `exports` map and no `main` or `typings` field.
A project compiled under classic `moduleResolution: "Node"` (node10) ignores
`exports` and resolves physically, so it cannot see the package at all and fails
with `TS2307: Cannot find module 'vscode-jsonrpc'` — before reaching any
Hydranium code. The subpaths do not rescue it: 9.x publishes no `node.js` or
`browser.js` at the package root either, so `vscode-jsonrpc/node` fails the same
way.

**The framework does not repair this for you, and cannot**: the packaging is
`vscode-jsonrpc`'s own, and this repository builds against it unmodified. So a
consuming project needs **a resolver that reads `exports`** —
`module` and `moduleResolution` both set to `"NodeNext"`, or, for bundled code,
`moduleResolution: "Bundler"` with `module: "ESNext"`. `"Node16"` reads
`exports` too, but `module: "Node16"` rejects a CommonJS file importing one of
the ES-module `@hydranium/*` packages (TS1479). Every `@hydranium/*` module
subpath is declared once, bare, so `"Node"` reaches none of them.

### Why `vscode-jsonrpc@8` is not a way out

Every protocol release in the Langium chain above pins a 9.x exactly, so an
`8.x` install adds a physical copy beside Langium's rather than replacing it.

### Several copies of `vscode-jsonrpc` in one install

A peer declaration settles the copy at the TOP of your tree. It cannot
reach a **nested** one, because a peer states what you must supply and says
nothing about what your other dependencies bring with them. A fresh install
nests several: `@eclipse-glsp/*` bring `vscode-jsonrpc@8.2.0`, and
`vscode-languageserver` and `vscode-languageserver-protocol` can bring 9.x
copies of their own.

This wire stack breaks on copy identity rather than on structure: a typed
message — a `RequestType` or `NotificationType` — built by one copy and sent
over a connection another copy created throws
`Unknown parameter structure auto`. The framework sends by method name on the
connections it creates or hands to GLSP, and `vscode-languageserver` does so on
the LSP connection.

A connection your own code creates or hands over is not covered. Each
`@eclipse-glsp/*` package can nest its own copy of `vscode-jsonrpc` `8.2.0`
(GLSP's upgrade to 9.x is open as
[eclipse-glsp/glsp#1720](https://github.com/eclipse-glsp/glsp/issues/1720)),
so GLSP's packages can split from each other: GLSP's VS Code integration
creates its connection from its own copy, while GLSP's client sends typed
messages built by `@eclipse-glsp/protocol`'s. So wherever you hand GLSP a
connection, wrap it with `sendByMethodName` from `@hydranium/protocol`, which
sends every typed message by its method name. One such place is GLSP's VS Code
integration, even unchanged: its `SocketGlspVscodeServer` creates the
connection from the integration's own copy, and its `createSocketConnection`
takes no logger, so the connection's faults leave no trace. Override
`createConnection` to build the socket connection yourself with
`createMessageConnection(reader, writer, logger)` and return it wrapped in
`sendByMethodName`, as the order-flow VS Code example does. Where your code sends a typed message over a raw
connection, such as the data socket, wrap it the same way or send by method
string. `sendByMethodName` returns the connection typed as whichever copy's
connection the place you pass it to expects, such as GLSP's
`connectionProvider`, so the TypeScript mismatch between two copies'
`MessageConnection` types needs no cast.

Errors do not survive the copies everywhere. A connection keeps a thrown
`ResponseError`'s code and data only when the error comes from the connection's
own copy; any other reaches the caller as a generic `InternalError`. A
`ResponseError` a handler returns from another copy is sent as a successful
result.

- The data socket and both GLSP launchers build their connections from the
  framework's copy, so the framework's errors keep their code there.
- On the LSP connection, Langium's own errors, such as a request for a document
  the server does not have, are right only with one copy of
  `vscode-languageserver-protocol`, since Langium returns them. And an LSP
  handler of yours that throws a `@hydranium/protocol` error keeps its code only
  when the framework shares the connection's `vscode-jsonrpc`. `init` pins
  `vscode-languageserver` to `10.0.1` exactly, and the protocol and
  `vscode-jsonrpc` to the versions it pins, `3.18.1` and `9.0.0`. A project
  not scaffolded by `init` should declare the same. The pins hold because npm
  settles Langium's `~3.18.1` on the declared `3.18.1`. Yarn 1 resolves it to
  the newest 3.18 instead and nests that under `langium`, so yarn 1 also needs
  `"resolutions": { "**/langium/vscode-languageserver-protocol": "3.18.1" }`.
  A resolution for `vscode-jsonrpc` itself would force GLSP's `8.2.0` onto 9.x,
  which breaks GLSP at startup. The Langium 4.4 upgrade
  ([#142](https://github.com/eclipse-emfcloud/hydranium/issues/142)) replaces
  these pins.

The framework recognises a `ResponseError` by its shape. Do the same in your
code: recognise errors with `isResponseError` and the `is…Error` guards from
`@hydranium/protocol`, not `instanceof`. A handler of yours that throws a
`ResponseError` from another copy than its connection's loses the code.

## Install Hydranium's LSP connection features

Every LSP connection used with Hydranium must be created with
`withHydraniumLspFeatures`:

```ts
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { withHydraniumLspFeatures } from '@hydranium/core/lsp';

const connection = createConnection(withHydraniumLspFeatures(ProposedFeatures.all));
```

This installs Hydranium's supported `RemoteConsole` integration. It suppresses
the expected rejected log notification when a peer has already disconnected,
while keeping unexpected logging failures visible. Without it, the upstream
language-server console reports `Sending log message failed` during normal
teardown. The wrapper must be supplied at each `createConnection` call site;
`startLanguageServer` receives an already-created connection and cannot add it
afterward.

## Related

- [Status, limitations and roadmap](status.md) — what the exact pin costs you,
  alongside the other known limitations.
- [Troubleshooting a server you are building](troubleshooting.md) — the
  symptoms a duplicated copy actually produces.
