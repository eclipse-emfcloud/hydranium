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

The published packages declare `vscode-jsonrpc` as an exact peer, which forces
the copy at the TOP of your tree and cannot reach a nested one. `@eclipse-glsp/*`
depends on `vscode-jsonrpc@8.2.0` exactly and this repository's root `overrides`
are not published, so a first install of the GLSP head lands two copies every
time — for that head the pin is mandatory rather than a fallback. Add it to your
own root manifest; [Requirements](requirements.md) gives the exact block.

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
