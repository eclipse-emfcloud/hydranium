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
@hydranium/protocol/testing       # test doubles, waiters, catalogue audit
@hydranium/protocol/testing/node  # the Node-only doubles
```

The root barrel re-exports `data` and `client`, so those two subpaths buy a
narrower surface rather than reach; `testing` is only reachable by its own
specifier, which is what keeps the doubles out of a production bundle. The RPC
machinery documents itself in [`src/rpc/README.md`](./src/rpc/README.md).

### Auditing a translation catalogue

An adopter with i18n has one failure mode nothing else catches: a catalogue key
naming no declared code falls back to the English, which is byte-identical to
the deliberately-partial behaviour every adopter relies on. So a typo is
invisible at runtime, and `theia nls-extract` reports what the source declares
rather than whether a catalogue matches it.

`@hydranium/protocol/testing` ships the audit for it — call it from your own
test, over your own barrels:

<!-- snippet-preamble
import { flattenCatalogue, findUndeclaredCodes, findSharedCodes } from '@hydranium/protocol/testing';
import * as protocolMessages from '@hydranium/protocol';
declare const readFileSync: (path: string, encoding: string) => string;
declare const expect: (actual: unknown) => { toEqual(expected: unknown): void };
-->

```ts
const keys = Object.keys(flattenCatalogue(JSON.parse(readFileSync('nls/de.json', 'utf-8'))));

// Every key names a code some barrel declares. `exemptPrefixes` is for keys no
// barrel CAN declare — a host mechanism taking its key as an inline literal.
expect(findUndeclaredCodes(keys, [protocolMessages])).toEqual([]);
```

`flattenCatalogue` joins nested keys with `/` (the separator a code already
uses, and what Theia does to a nested catalogue) and drops `_`-prefixed note
keys, so a flat server-side catalogue and a nested host-side one both go through
it. `findSharedCodes` covers the other half: exactly one side renders a given
message, so two catalogues holding one code are two authorities over one
sentence — assert both key sets non-empty first, since an empty one satisfies
disjointness while proving nothing.

## Status

Alpha — pre-v0. The package is being populated incrementally, and its API is
not yet stable. See the [repository README](../../README.md) for the current
status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](../../NOTICE.md) for third-party notices.
