# Requirements for a consuming project

What your project must satisfy before `@hydranium/*` installs and compiles.
The one that surprises people is the single physical copy of Langium.

## Node 22.13 or newer

The packages declare this floor in `engines.node`. The Theia client packages
are CommonJS and `require()` the ES-module heads, which Node supports
unflagged only from 22.13.

## npm 11.6 or newer, or `vitest` below 4.1

npm before 11.6, including every npm a Node 22 release bundles, crashes on a
fresh install that includes `vitest` 4.1 or later, with `Cannot read
properties of null (reading 'edgesOut')`
([npm/cli#8261](https://github.com/npm/cli/issues/8261)). `init` holds the
scaffold's `vitest` at `~4.0.18`, unless it can tell that every npm installing
the project is 11.6 or later. Raise the hold yourself once that is true.

## One physical copy of Langium, and the wire stack pinned under it

The files `langium-cli` generates import `langium` directly, so your project
declares `langium` as well as the framework. If your declaration resolves to a
different version from the one `@hydranium/langium` depends on, npm silently
installs a second copy. Your generated code then runs on one copy and the
framework on the other:

- `tsc` fails with errors that do not name the cause, such as
  `Types have separate declarations of a private property`.
- A cancelled validation check that imports `langium` reports
  `An error occurred during validation: Symbol(OperationCancelled)`.
- The server refuses to start when your AST reflection comes from another copy.

Declare these exact versions, as `init` does:

- `langium` `4.3.1`
- `vscode-languageserver` `10.0.1`
- `vscode-languageserver-protocol` `3.18.1`
- `vscode-jsonrpc` `9.0.0`

The LSP stack is pinned with Langium because each
`vscode-languageserver-protocol` release pins its own `vscode-jsonrpc` exactly.
Any protocol release other than `3.18.1` brings a second `vscode-jsonrpc`
beside the one `vscode-languageserver@10.0.1` uses. Bump `langium` and this
stack together.

The framework's peer ranges follow the same chain. `@hydranium/core` declares
`vscode-languageserver` at `~10.0.1` and `vscode-languageserver-protocol` at
`~3.18.1`, and every head declares `vscode-jsonrpc` at `^9.0.0`. If you supply
a version outside a range, npm still installs, with an `ERESOLVE` warning that
names the required and the found version. Under `--strict-peer-deps` it is an
error.

Pins take effect only on a from-scratch install. Deleting the lockfile alone
leaves stale nested copies behind:

```bash
rm -rf node_modules package-lock.json
npm install
```

**In a workspace,** declare the same exact pins in the root's
`devDependencies` too, as `init --monorepo` prints. Do not put them in the
root's `overrides`, which would force them on every other member. npm installs
a root's own dependencies at the top of the tree. Without them, another
member's `langium` or LSP packages can take the top, and your package gets its
own copies beside the framework's, even of the same versions.

**With yarn 1,** also declare
`"resolutions": { "**/langium/vscode-languageserver-protocol": "3.18.1" }`.
npm settles Langium's `~3.18.1` on your declared `3.18.1`; yarn 1 nests the
newest 3.18 under `langium` instead. Do not add a resolution for
`vscode-jsonrpc`: it would force GLSP's own copy onto 9.x, and GLSP fails at
startup.

## TypeScript 5.4 or newer

The declarations of Langium and its LSP stack use `NoInfer`, which TypeScript
5.4 introduced. `skipLibCheck`, which an `init` scaffold sets, hides the errors
an older compiler reports, but those types then resolve to an error type.
Nothing in your install enforces this floor.

## A resolver that reads `exports`

Every 9.x release of `vscode-jsonrpc` ships an `exports` map and no `main` or
`typings` field. Under classic `moduleResolution: "Node"`, TypeScript ignores
`exports`, so it fails with
`TS2307: Cannot find module 'vscode-jsonrpc'` before reaching any Hydranium
code. `vscode-jsonrpc/node` fails the same way. The framework cannot repair
this, because the packaging is `vscode-jsonrpc`'s own. Each `@hydranium/*`
subpath is also reachable only through `exports`.

Set one of:

- `module` and `moduleResolution` both to `"NodeNext"`;
- for bundled code, `moduleResolution: "Bundler"` with `module: "ESNext"`.

`"Node16"` reads `exports` too, but `module: "Node16"` rejects a CommonJS file
that imports an ES-module `@hydranium/*` package (TS1479).

### Why `vscode-jsonrpc@8` is not a way out

Every protocol release in the Langium chain pins a 9.x exactly, so installing
`8.x` adds a copy beside Langium's rather than replacing it.

### Several copies of `vscode-jsonrpc` in one install

The pins above settle the copy at the top of your tree. They cannot remove
nested copies: `@eclipse-glsp/*` packages bring `vscode-jsonrpc@8.2.0`, and
each GLSP package can nest its own.

A typed message (a `RequestType` or `NotificationType`) built by one copy and
sent over a connection another copy created throws
`Unknown parameter structure auto`. The framework and `vscode-languageserver`
send by method name on the connections they create. A connection your code
creates or hands over is yours to cover:

- **Wherever you hand GLSP a connection,** wrap it with `sendByMethodName` from
  `@hydranium/protocol`. Its return type matches what the receiver expects,
  such as GLSP's `connectionProvider`, so you need no cast.
- **In VS Code,** override `createConnection` on GLSP's
  `SocketGlspVscodeServer`. Build the socket connection with
  `createMessageConnection(reader, writer, logger)` and return it wrapped in
  `sendByMethodName`, as the order-flow VS Code example does. The default
  creates the connection from GLSP's own copy and takes no logger.
- **Where you send a typed message over a raw connection,** such as the data
  socket, wrap the connection the same way or send by method string.

Errors also lose information across copies. A connection keeps a thrown
`ResponseError`'s code and data only when the error comes from its own copy;
any other reaches the caller as a generic `InternalError`, and one a handler
returns is sent as a successful result. The framework builds its data and GLSP
connections from its own copy. On the LSP connection, Langium's errors and your
handlers' `@hydranium/protocol` errors keep their codes only with the exact
pins above.

Recognise errors with `isResponseError` and the `is…Error` guards from
`@hydranium/protocol`, never with `instanceof`.

## Install Hydranium's LSP connection features

Create every LSP connection with `withHydraniumLspFeatures`:

```ts
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { withHydraniumLspFeatures } from '@hydranium/core/lsp';

const connection = createConnection(withHydraniumLspFeatures(ProposedFeatures.all));
```

Without it, the console reports `Sending log message failed` during normal
teardown, when a peer has already disconnected. Unexpected logging failures
stay visible. `startLanguageServer` receives a connection already created, so
it cannot add the features for you.

## Related

- [Status and limitations](status.md): what the exact pin costs you.
- [Troubleshooting a server you are building](troubleshooting.md): the
  symptoms a duplicated copy produces.
