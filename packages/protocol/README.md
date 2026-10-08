# `@hydranium/protocol`

The contract shared between
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) servers and their
clients. With `vscode-jsonrpc`, it is the only Hydranium package a pure client
needs: a form editor, a tree view or a code generator talking to the data head
never depends on `@hydranium/core`, which carries the Langium runtime.

## What it gives you

- Type your client against `DataServerProtocol` and `DataClientProtocol`.
- Connect, reconnect and open documents through one client tier, in a Theia
  frontend, a VS Code extension or webview, or a plain browser page.
- Declare your own RPC contract as a TypeScript interface and use it on both
  ends of a connection.
- Test your client, and audit your translation catalogues (see *Translate your
  language* in
  [Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md)).

## Install

```bash
npm install @hydranium/protocol vscode-jsonrpc
```

| Peer             | Range    |
| ---------------- | -------- |
| `vscode-jsonrpc` | `^9.0.0` |

## The RPC pattern

You declare a contract `T`, bind it on the server with `bindRpcMethods`, and
call it with `createRpcProxy<T>`. Nothing between the two is hand-written, so
the compiler keeps the ends agreeing.

```
   your contract T                      your contract T
        │                                     │
        ▼                                     ▼
   bindRpcMethods                       createRpcProxy<T>
   (server side)                         (caller side)
        │                                     │
        └──── MessageConnection ──────────────┘
              (vscode-jsonrpc)
```

The options both ends must agree on, and a worked example, are in
[`src/rpc/README.md`](./src/rpc/README.md).

## Entry points

| Subpath          | Use it for                                                  | Runs in         |
| ---------------- | ----------------------------------------------------------- | --------------- |
| `.`              | The production surface, `./data` and `./client` included    | browser-neutral |
| `./data`         | The data-head protocol types alone                          | browser-neutral |
| `./client`       | The client tier alone                                       | browser-neutral |
| `./messages`     | The message codes this package raises                       | browser-neutral |
| `./node`         | Process-memory and heap-snapshot diagnostics                | Node-only       |
| `./testing`      | Test doubles, waiters and the translation-catalogue audit   | browser-neutral |
| `./testing/node` | In-memory stream and port pairs for tests                   | Node-only       |

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
