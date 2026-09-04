# `@hydranium/protocol`

Generic, language-agnostic types, constants, and pure utilities for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework.

This package is the contract surface shared between hydranium servers and
their clients. It contains:

- Cross-reference and reference-resolution types.
- The `TransferDocument<TTransfer, TDiagnostic>` transfer-document wrapper.
- The generic `DataServerProtocol` and `DataClientProtocol` RPC interfaces.
- Pure utility functions and version constants.

**Dependency budget:** one runtime dependency, `fast-json-patch`. Anything
heavier (transport, Inversify, Theia, Langium runtime) lives in consuming
packages.

## Install

```bash
npm install @hydranium/protocol
```

This is the only hydranium package a pure client needs. A form editor, a tree
view or a code generator talking to the data head depends on this and on
`vscode-jsonrpc` for the transport — never on `@hydranium/core`, which carries
the Langium runtime and does not bundle for a client.

## The RPC pattern

The data head is not a bespoke wire format — it is a TypeScript interface, bound
on one side and proxied on the other. An adopter declares a contract `T`, binds
it with `bindRpcMethods`, and consumes it with `createRpcProxy<T>`; nothing
between the two is hand-written, and the compiler is what keeps the ends
agreeing.

```
   adopter contract T                   adopter contract T
        │                                     │
        ▼                                     ▼
   bindRpcMethods                       createRpcProxy<T>
   (server side)                         (caller side)
        │                                     │
        └──── MessageConnection ──────────────┘
              (vscode-jsonrpc)
```

The two helpers are deliberately symmetric — the same wire-name composition
rule, the same notification heuristic, the same deferred-connection support — so
a contract written once works on both ends with no per-method configuration.
Both are exported from the package root; there is no `/rpc` subpath.

Full reference — the options both ends must agree on, the reserved property
names, a worked example — is in
[`src/rpc/README.md`](./src/rpc/README.md), which ships in the tarball.

## Subpaths

```bash
@hydranium/protocol               # transfer documents, references, RPC machinery
@hydranium/protocol/data          # DataServerProtocol / DataClientProtocol
@hydranium/protocol/client        # the host-neutral client tier
@hydranium/protocol/testing       # test doubles and waiters
@hydranium/protocol/testing/node  # the Node-only doubles
```

The root barrel re-exports `data` and `client`, so those two subpaths buy a
narrower surface rather than reach; `testing` is only reachable by its own
specifier, which is what keeps the doubles out of a production bundle. The RPC
machinery documents itself in [`src/rpc/README.md`](./src/rpc/README.md).

## Status

Alpha — pre-v0. The package is being populated incrementally, and its API is
not yet stable. See the [repository README](../../README.md) for the current
status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](../../NOTICE.md) for third-party notices.
