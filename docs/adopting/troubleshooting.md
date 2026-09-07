# Troubleshooting a server you are building

Failure modes that are hard to diagnose from their symptom, because the message
names the wrong layer. Each entry starts with what you actually see.

For what the framework *does not do yet* — as opposed to what has gone wrong —
see [Status, limitations and roadmap](status.md). For failures that only happen
while building or testing the framework repository itself, see
[Troubleshooting the repository](../contributing/troubleshooting.md).

## `instanceof` and typeguards fail on nodes that are obviously the right type

A validation never fires, a scope provider sees no candidates, or a `URI`
comparison is false for two spellings of the same document. No error message
names the cause.

Two physical copies of `langium` in the install. Class identity is nominal, so
an `AstNode` or `URI` produced by one copy fails every identity check made by
the other, and nothing throws — the checks just answer `false`.

The single-physical-copy requirement and the pinned chain it implies are stated
in [Requirements](requirements.md); bumping one link of that chain alone
reintroduces the split.

**Remedy:** confirm the duplication, then reinstall from scratch. `overrides`
and patches take effect only on a from-scratch install; deleting the lockfile
alone leaves stale nested copies behind.

```bash
npm ls langium
rm -rf node_modules package-lock.json
npm install
```

## `Unknown parameter structure auto`

Thrown while a server head initializes — the GLSP head is where it usually
surfaces first.

Two physical copies of `vscode-jsonrpc`. `ParameterStructures.auto` is a
singleton compared by identity, so a request type built by one copy, sent over a
connection owned by another, falls through the dispatch and throws. The heads
share one connection in a single process, so the copies have to collapse onto
one.

This is the same class of fault as the `langium` entry above and has the same
remedy — a from-scratch install, so the root `overrides` and the
`patch-package` patch both apply.

The published packages declare peer ranges, not overrides, and a graph that
satisfies every range can still contain two `vscode-jsonrpc` copies. Add the pin
to your own root manifest; [Requirements](requirements.md) gives the exact
block.

## `MethodNotFound` on `workspace/applyEdit`, or a server-side write that never appears

A write made on the server — a diagram operation, an integrity repair — does not
show up in the client's editor, and nothing obviously fails.

LSP puts the file write on the client, so a server-side change to an open
document goes out as a `workspace/applyEdit` request. The framework does not
gate that request on a client capability: it is sent on every server-side write
to an open document, whatever the client declared. A client that sends `didOpen`
and binds no `applyEdit` handler answers `MethodNotFound`. The framework logs
that over `window/logMessage` — and a client with no handler for *that* loses
the whole inbound direction in silence.

**Remedy:** bind both. Handle `workspace/applyEdit` and apply the edit to your
editor's model, and surface `window/logMessage` somewhere a developer will see
it. A host that only reads documents and never displays them still wants the
second one.

## Semantic tokens are missing under a Theia plugin-host

Highlighting from the language server does not reach Monaco when the server runs
inside a Theia plugin-host, while the same server highlights correctly in VS
Code and in a direct Theia backend connection.

This is a known limitation rather than a misconfiguration; it is described with
what has been established about it in
[Status, limitations and roadmap](status.md).

## Still stuck

Server-side logging is the fastest way to see which hop stalled. Every service
holds a tracer, the log level is a bindable setting, and a per-test server log
can be captured and attached to a failing test — the test-support layer is
described in [Testing](../contributing/testing.md).
