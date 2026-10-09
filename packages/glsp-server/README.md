# `@hydranium/glsp-server`

The graphical-editing head of
[Hydranium](https://github.com/eclipse-emfcloud/hydranium): a
[GLSP](https://eclipse.dev/glsp/) server that draws diagrams from your model
and writes their edits back to it. Install it in the server that composes
`@hydranium/core`; in Theia, `@hydranium/glsp-client-theia` is its client.

## What it gives you

- Diagrams on the same workspace as the text editor: an edit in the diagram is
  written to the shared document, and every other head sees it.
- A per-diagram module and base classes for its state, storage and submission.
  You write the GModel factory and the operation handlers.
- The language's diagnostics as markers on the diagram, when you bind
  `HydraniumGlspModelValidator` as the diagram's model validator.

## Install

```bash
npm install @hydranium/glsp-server
```

| Peer                          | Range         |
| ----------------------------- | ------------- |
| `@eclipse-glsp/server`        | `^2.6.0`      |
| `@hydranium/core`             | `^1.0.0-next` |
| `@hydranium/langium`          | `^1.0.0-next` |
| `@hydranium/protocol`         | `^1.0.0-next` |
| `inversify`                   | `^6.0.0`      |
| `reflect-metadata`            | `^0.2.2`      |
| `vscode-jsonrpc`              | `^9.0.0`      |
| `vscode-languageserver-types` | `^3.17.5`     |

Import `reflect-metadata` once, first, in your server's entry point: the DI
decorators need it.

## Wiring

1. Subclass `AbstractHydraniumGlspDiagramModule` per diagram, and bind your
   model state, storage, submission handler, configuration and GModel factory.
2. Start the head on the shared services with `startGlspServer` from `./node`:
   your diagram modules in `serverModule`,
   `new HydraniumGlspAppModule({ shared })` in `appModules`, and a
   `GlspClientLogger` from `createLogger`. Pass `lspConnection` and
   `portCommand` to tell the client its port.
3. In a browser, start it with `startGlspServerInWorker` from `./browser`
   instead, on a transferred `MessagePort`.

See *Make a diagram editable* and *Host in a browser* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Things to know

- **Replace the launcher with `rebind`.** Each head binds GLSP's launcher token
  before your `appModules` load, so a second `bind` fails the start with
  `Ambiguous match found for serviceIdentifier`.
- **A replacement launcher extends the Hydranium one**,
  `HydraniumGlspSocketServerLauncher` or `HydraniumGlspWorkerServerLauncher`.
  If it overrides `createConnection`, it passes
  `createGlspConnectionLogger(this.logger)` as the connection's logger, or the
  connection logs to `console` or nowhere instead of your logger, and wraps the
  result in `dropNotificationsToGoneClient(connection, this.logger)`, or every
  client that disconnects leaves an unhandled rejection in the server.
- **GLSP brings its own copy of `vscode-jsonrpc`.** A typed message built by
  one copy and sent over a connection from another throws
  `Unknown parameter structure auto`. Wrap a connection you hand GLSP, or send
  GLSP's typed messages over, with `sendByMethodName` from
  `@hydranium/protocol`.

## Entry points

| Subpath      | Use it for                                                   | Runs in         |
| ------------ | ------------------------------------------------------------ | --------------- |
| `.`          | The app and diagram modules and the bases you subclass       | browser-neutral |
| `./browser`  | Starting the head in a web worker                            | browser-only    |
| `./node`     | Starting the head on a socket                                | Node-only       |
| `./messages` | The codes of the messages this package raises                | browser-neutral |
| `./testing`  | A harness and logger doubles for diagram tests               | browser-neutral |

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
