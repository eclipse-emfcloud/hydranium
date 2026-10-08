# order-flow

The complete application behind the
[live demo](https://eclipse-emfcloud.github.io/hydranium/). Order fulfillment
is modelled in three grammars and served by all three heads (LSP, the typed
data server and GLSP) over one shared Langium workspace. The same server runs
in a Theia app, a VS Code extension and a plain browser page. Look things up
here when you build your own application.

**Everything here must be fit to copy.** Adopters look things up in this
example and copy from it, and `hydranium-cli init` derives its templates from
it, so a shortcut here spreads to every project that does either. Write
built-ins in the language's own syntax and load them with
`LangiumDocumentFactory.fromString`, never as an AST built by hand past the
generated types, and test every branch of an API a suite claims to cover.

For what `hydranium-cli init` scaffolds, see
[bookstore](../bookstore/README.md), and read it beside your own scaffold.

## The three grammars

| Extension | Language id | What it holds |
| --- | --- | --- |
| `.domain` | `order-flow-domain` | entities, value types, enumerations, typed fields |
| `.process` | `order-flow-process` | tasks, gateways and transitions over a domain entity |
| `.layout` | `order-flow-layout` | node bounds for one process, optional, in its own file |

References point one way: `.layout` depends on `.process`, which depends on
`.domain`. There is no `.diagram` grammar. A diagram is a `.process` document
rendered by the GLSP head, positioned by its sibling `.layout` file.
[server/README.md](server/README.md) explains the grammars and the
cross-grammar reference chain they exist for.

## Where to look

| Concern | Where | Guide |
| --- | --- | --- |
| Grammars | [server/src/grammar/](server/src/grammar/) | |
| Language composition | [order-flow-module.ts](server/src/language-server/order-flow-module.ts), [services.ts](server/src/services.ts) | [Compose a server by hand](../../docs/guides/compose-a-server.md) |
| Scoping | [process-scope-provider.ts](server/src/language-server/process-scope-provider.ts), [layout-scope-provider.ts](server/src/language-server/layout-scope-provider.ts), [order-flow-scope-computation.ts](server/src/language-server/order-flow-scope-computation.ts) | [Customizing names, scope and visibility](../../docs/concepts/customizing-names-and-scope.md) |
| Validation | [process-validation.ts](server/src/language-server/process-validation.ts), [layout-validation.ts](server/src/language-server/layout-validation.ts) | [Add a validation check](../../docs/guides/add-validation-check.md) |
| Serialization | [domain-serializer.ts](server/src/language-server/domain-serializer.ts), [process-serializer.ts](server/src/language-server/process-serializer.ts), [layout-serializer.ts](server/src/language-server/layout-serializer.ts) | |
| Built-in types | [order-flow-stdlib.ts](server/src/language-server/order-flow-stdlib.ts) | [Ship a standard library](../../docs/guides/ship-a-standard-library.md) |
| Diagram, server side | [server/src/glsp/](server/src/glsp/), operation handlers in [server/src/glsp/handler/](server/src/glsp/handler/) | [Make a diagram editable](../../docs/guides/editable-diagram.md) |
| Diagram, client side | [client/src/diagram/](client/src/diagram/) | |
| Properties view | [client/src/data/](client/src/data/), [client/src/properties/](client/src/properties/), [theia/src/browser/order-flow-properties-widget.ts](theia/src/browser/order-flow-properties-widget.ts) | [Connect a data client](../../docs/guides/connect-a-data-client.md) |
| Theia host | [theia/](theia/README.md), [theia-app/](theia-app/README.md) | [Host in Theia](../../docs/guides/host-in-theia.md) |
| VS Code host | [vscode/](vscode/README.md), [vscode-servers/](vscode-servers/README.md) | |
| Browser host, no backend | [browser/](browser/README.md) | [Host in a browser](../../docs/guides/host-in-a-browser.md) |
| Translations | [theia/src/nls/order-flow.de.json](theia/src/nls/order-flow.de.json), [server/src/nls/order-flow.de.json](server/src/nls/order-flow.de.json) | [Translate your language](../../docs/guides/translate-your-language.md) |
| Unit tests | each package's `test/` | [Test your language](../../docs/guides/test-your-language.md) |
| End-to-end tests | [theia-app/test/e2e/](theia-app/test/e2e/), [browser/test/e2e/](browser/test/e2e/), [vscode/test/host/](vscode/test/host/), [vscode/test/e2e/](vscode/test/e2e/) | |
| Sample models | [workspace/](workspace/README.md) | |

Each directory is one npm package, named `@hydranium/example-order-flow-*`.
`workspace/` is a fixture tree, not an npm workspace. Each package's README
covers its own e2e commands and launch configurations.

## Running it

```bash
npm run build:all                                  # every package, in dependency order

npm run start:order-flow                           # build + Theia app on http://localhost:3001
npm run dev:order-flow                             # watch: framework + server/client/theia/app

npm --prefix examples/order-flow/browser run build
npm --prefix examples/order-flow/browser start     # http://localhost:3002

npm --prefix examples/order-flow/vscode run build:all   # then F5 in VS Code

npm --prefix examples/order-flow/server run build
npm --prefix examples/order-flow/server start      # LSP on stdio, data and GLSP heads on sockets
```

## The fixture workspace is edited in place

`workspace/` is a checked-in test fixture, and two ways to run this example
open it directly: the Theia app's `npm start` passes `../workspace` to
`theia start`, and the VS Code F5 launch opens the same folder. Anything you
type there changes the seed other suites copy. So does a write from a
properties panel, which reserializes the whole document.

Nothing warns you, because the suites still pass: they copy the file you
changed. Run `git status examples/order-flow/workspace` after any manual
session, and `git checkout --` what you did not mean to keep. The end-to-end
suites are safe, because they copy the tree into a temp directory first. So is
the browser page, which seeds an in-memory filesystem and persists to
`IndexedDB`.
