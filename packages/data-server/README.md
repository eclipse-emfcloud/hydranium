# `@hydranium/data-server`

The data head of [Hydranium](https://github.com/eclipse-emfcloud/hydranium): it
serves your model over JSON-RPC to clients other than a text editor, such as
forms, tree views and code generators. Install it in the server that composes
`@hydranium/core`; a client talks to it through `@hydranium/protocol`.

## What it gives you

- Typed reads, updates and saves of documents in the shared workspace, as your
  transfer model. An edit from a data client reaches the other heads.
- Notifications when a document is rebuilt, saved or deleted, so a client
  never polls.
- Your own methods on the same connection, through a `DataServer` subclass and
  its `additionalMethods` option.
- An optional reference and naming slice: pass
  `REFERENCE_SERVER_PROTOCOL_METHODS` from `@hydranium/protocol/data` in
  `additionalMethods`.

## Install

```bash
npm install @hydranium/data-server
```

| Peer                                 | Range         |
| ------------------------------------ | ------------- |
| `@hydranium/core`                    | `^1.0.0-next` |
| `@hydranium/langium`                 | `^1.0.0-next` |
| `@hydranium/protocol`                | `^1.0.0-next` |
| `vscode-jsonrpc`                     | `^9.0.0`      |
| `vscode-languageserver-textdocument` | `^1.0.12`     |

## Wiring

The head adds no services module: it reads the shared services you composed
with `@hydranium/core`.

1. Start a launcher from `@hydranium/core/node`: `startSocketServer` beside the
   LSP head, with `publishPortOnLspConnection` to tell the client its port, or
   `startStdioServer` for a data head alone.
2. In its connection callback, create `new DataServer(connection, shared)`. It
   cleans up when the connection closes.

See *Add a data-server method* and *Connect a data client* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath      | Use it for                                                 | Runs in         |
| ------------ | ---------------------------------------------------------- | --------------- |
| `.`          | `DataServer`, its options, and the diagnostics seam        | browser-neutral |
| `./node`     | The Node implementation of the diagnostics seam            | Node-only       |
| `./messages` | The codes of the messages this package raises              | browser-neutral |
| `./testing`  | A harness that drives a real data head in-process          | Node-only       |

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
