# `@hydranium/core`

The runtime of [Hydranium](https://github.com/eclipse-emfcloud/hydranium): the
shared Langium workspace your language server is built from, plus the LSP head.
Every Hydranium server installs it, and `@hydranium/data-server` and
`@hydranium/glsp-server` build on it.

## What it gives you

- One call, `createIntegrationServices`, that composes your language's services
  with Langium's defaults and the framework's.
- Scoping, naming, validation and build hooks you extend per language, rather
  than rewrite.
- One workspace every head works on: an edit made through one head is seen by
  the others.
- The LSP head, and launchers that serve another head over stdio or a socket.

## Install

```bash
npm install @hydranium/core
```

| Peer                                 | Range         |
| ------------------------------------ | ------------- |
| `@hydranium/langium`                 | `^1.0.0-next` |
| `@hydranium/protocol`                | `^1.0.0-next` |
| `@playwright/test`                   | `^1.40.0`     |
| `vscode-jsonrpc`                     | `^9.0.0`      |
| `vscode-languageserver`              | `~10.0.1`     |
| `vscode-languageserver-protocol`     | `~3.18.1`     |
| `vscode-languageserver-textdocument` | `^1.0.12`     |
| `vscode-languageserver-types`        | `^3.17.5`     |

Import Langium through `@hydranium/langium`, so your project uses the same copy
as the framework. `@playwright/test` is optional; only `./testing/playwright`
needs it.

## Wiring

`hydranium-cli init` scaffolds a starter grammar and all of this wiring.

1. Compose the services with `createIntegrationServices`, passing
   `createLspServerSharedModule` and `createLspServerLanguageModule` as the
   extra modules. Your language module binds a `Serializer`.
2. Create the LSP connection with `withHydraniumLspFeatures`, and start it with
   `startLanguageServer` from `./lsp`, not Langium's: it fails the start when
   the LSP shared module is missing.
3. Start other heads on the same shared services, with `startSocketServer` and
   `publishPortOnLspConnection` beside the LSP head, or `startStdioServer`
   alone.

See *Compose a server by hand* and *Add a validation check* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath                | Use it for                                                                   | Runs in         |
| ---------------------- | ---------------------------------------------------------------------------- | --------------- |
| `.`                    | Composing services and extending the language's semantics                    | browser-neutral |
| `./lsp`                | The LSP head and its modules                                                 | browser-neutral |
| `./node`               | The Node filesystem, the stdio and socket launchers, the headless tools      | Node-only       |
| `./messages`           | Validation messages with stable codes, and the codes this package raises     | browser-neutral |
| `./testing`            | Parsing and service doubles for unit tests                                   | browser-neutral |
| `./testing/node`       | Scratch workspaces, the LSP harness, a spawned server                        | Node-only       |
| `./testing/playwright` | Playwright fixtures that capture the server log                              | Node-only       |

The subpaths need a TypeScript `moduleResolution` that reads `exports`
(`NodeNext` or `Bundler`); see *Requirements* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Status

Alpha: every release is a prerelease that may break the API, so pin an exact
version. Guides and known limitations:
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](https://github.com/eclipse-emfcloud/hydranium/blob/main/NOTICE.md)
for third-party notices.
