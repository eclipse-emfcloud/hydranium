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

**Remedy:** confirm the duplication, then reinstall from scratch. Pins take
effect only on a from-scratch install; deleting the lockfile alone leaves stale
nested copies behind.

```bash
npm ls langium
rm -rf node_modules package-lock.json
npm install
```

## The lint rule banning direct `langium` imports never fires

You added a rule to keep imports on the `@hydranium/langium` chokepoint — the
prevention for the entry above — lint is green, and direct `langium` imports go
on landing. No error, no warning, no report that a rule was dropped.

ESLint **replaces** a rule's configuration per scope rather than merging it. Two
configurations naming the same rule id do not combine: the later one wins
outright. So a chokepoint rule placed before a shared config that already owns
`no-restricted-imports` is discarded entirely, and ESLint says nothing — a
discarded rule is indistinguishable from a rule with nothing to report.

The base `no-restricted-imports` and `@typescript-eslint/no-restricted-imports`
are **separate rule ids**. Using the typescript-eslint one side-steps a shared
config that owns the base one, and it is the right id anyway: it can distinguish
type-only from value imports. (This framework's own config uses both, for
exactly that independence.)

**Remedy:** use the typescript-eslint id, and exempt generated output —
`langium-cli` rewrites those files on every build, so a violation there is not
fixable in your tree.

```js
{
   files: ['src/**/*.ts'],
   ignores: ['**/generated/**'],
   rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
         paths: [
            { name: 'langium', message: 'Import Langium via @hydranium/langium, not the upstream package.' },
            { name: 'langium/lsp', message: 'Import via @hydranium/langium/lsp.' },
            { name: 'langium/node', message: 'Import via @hydranium/langium/node.' },
            { name: 'langium/test', message: 'Import via @hydranium/langium/test.' },
            { name: 'vscode-uri', message: 'Import URI via @hydranium/langium, which re-exports it.' }
         ]
      }]
   }
}
```

Confirm the rule survived rather than assuming it did — resolve the config for a
file it should cover and check the rule is present with your paths:

```bash
npx eslint --print-config src/some-file.ts
```

`langium` stays a declared dependency regardless: the generated files import it
directly, which is why they are exempt rather than fixed.

## A framework fix disappears after you rebind a service

Completion stops inserting correctly, a scope stops resolving something it used
to, a diagnostic stops appearing — and it starts the moment you bind your own
implementation of that service. Your class looks right and compiles cleanly.

You extended the **upstream** base class rather than the framework's. For
several Langium and GLSP services the framework binds its own subclass, which
carries fixes on top of the upstream default. A slot's declared type is the
upstream interface, so both satisfy it and nothing complains — but subclassing
`DefaultCompletionProvider` instead of `HydraniumCompletionProvider` silently
gives up everything the framework added.

Nothing reports this. There is no error and no warning; the behaviour simply
reverts to upstream.

**Remedy:** before rebinding any service, check whether the framework already
specialises it, and extend that class instead. Two ways to find out:

- The module declares its overrides explicitly. In
  `packages/core/src/lsp/language-module.ts` the slot is marked
  `/* override */ CompletionProvider: HydraniumCompletionProvider;` — an
  `/* override */` on a slot means the framework has a specialisation there.
- The naming convention answers it directly. A `Hydranium*` class is by
  definition the framework's version of an upstream Langium/GLSP/Theia class;
  the prefix exists to keep it distinct from the upstream `Default*` an adopter
  also imports. So `HydraniumScopeProvider`, `HydraniumDocumentBuilder`,
  `HydraniumCompletionProvider` and their siblings are each a "use this one"
  signal.

To list every specialisation the framework ships:

```bash
grep -rE '^export (abstract )?class Hydranium\w+ extends ' node_modules/@hydranium/*/src
```

Rebinding to a class that does *not* derive from the framework's is supported —
sometimes it is what you want. The point is that it should be a decision rather
than an accident.

## `Unknown parameter structure auto`

Thrown when a typed message, a `RequestType` or `NotificationType`, is sent over
a raw `vscode-jsonrpc` connection: by your own code, or by GLSP over a
connection it was handed. GLSP's VS Code integration does this even unchanged:
its `SocketGlspVscodeServer` creates the connection from the integration's own
copy.

Two physical copies of `vscode-jsonrpc`. `ParameterStructures.auto` is a
singleton compared by identity, so a typed message built by one copy and sent
over a connection another copy created falls through the dispatch and throws.
An install holds several copies as a matter of course: the published packages
declare `vscode-jsonrpc` as a peer, which settles the copy at the TOP of your
tree and cannot reach the ones the LSP packages nest, or the one each
`@eclipse-glsp/*` package can nest for itself. The framework sends by method
name on the connections it creates or hands to GLSP, and so does the LSP
connection.

Wrap every connection you hand GLSP with `sendByMethodName` from
`@hydranium/protocol`, including the VS Code integration's, by overriding its
`createConnection`, and send your own messages by method string or over a
connection wrapped the same way. If your root `overrides` pin `vscode-jsonrpc`
or `vscode-languageserver-protocol`, or you apply a `vscode-jsonrpc` patch, as
an earlier version of [Requirements](requirements.md) advised, remove them as
that page now describes. It also has the detail.

A GLSP diagram in Theia that never receives a message, with
`No runtime abstraction layer installed` in the console, is the same split:
`@hydranium/glsp-client-theia` sets up the copy it resolves, so it has to
resolve the top-level copy GLSP's Theia integration uses, not a nested one.

## A `ResponseError` arrives as `InternalError` or as a result, or an `instanceof` check misses it

A handler throws a `ResponseError` with a code, and the caller receives
`InternalError` with the message folded into `Request … failed with message: …`.
Or your code checks a rejection with `instanceof ResponseError`, and the check
answers `false` for an error that plainly carries a code.

The same copies as above. A connection keeps a thrown `ResponseError`'s code and
data only when the error comes from the connection's own copy of
`vscode-jsonrpc`, and `instanceof` recognises only the copy it was imported
from. The framework's own errors keep their code over the data and GLSP
connections it builds. The LSP connection is `vscode-languageserver`'s, so an
LSP handler of yours that throws a `@hydranium/protocol` error keeps its code
only when the framework shares that copy. Declare `vscode-jsonrpc` at `9.0.0`,
the version `vscode-languageserver@10.0.1` resolves, as `init` does, until the
Langium 4.4 upgrade
([#142](https://github.com/eclipse-emfcloud/hydranium/issues/142)) replaces the
pin.

Recognise errors with `isResponseError` and the `is…Error` guards from
`@hydranium/protocol` instead of `instanceof`, and throw a `ResponseError` from
the copy that built the connection the handler runs on.

A `ResponseError` a handler returns, rather than throws, from another copy
arrives as the request's result. Langium returns its errors, so an LSP request
for a missing document can resolve with `{"code":-32802}`. Declare
`vscode-languageserver` at `10.0.1` and `vscode-languageserver-protocol` at
`3.18.1`, the version it pins, as `init` does, and reinstall from scratch.

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

## Semantic tokens add no colour in Theia

The server's semantic highlighting shows in VS Code but not in Theia, wherever
Theia runs the server; turning `editor.semanticHighlighting.enabled` on leaves
most names in the editor's default foreground.

This is a known limitation rather than a misconfiguration: Theia's themes have
no colours for semantic token types. The mechanism, and what a host can do about
it, are in
[Status, limitations and roadmap](status.md#semantic-tokens-add-no-colour-in-theia).

## Still stuck

Server-side logging is the fastest way to see which hop stalled. Every service
holds a tracer, the log level is a bindable setting, and a per-test server log
can be captured and attached to a failing test — the test-support layer is
described in [Testing](../contributing/testing.md).
