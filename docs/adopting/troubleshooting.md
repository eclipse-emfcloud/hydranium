# Troubleshooting a server you are building

Failure modes that are hard to diagnose from their symptom, because the message
names the wrong layer. Each entry starts with what you actually see.

For what the framework does not do, as opposed to what has gone wrong, see
[Status and limitations](status.md).

## Startup rejects the AST reflection, or a cancelled validation reports `Symbol(OperationCancelled)`

The server throws a `[hydranium]` error at startup saying its AST reflection
extends `AbstractAstReflection` from another instance of `langium` than the one
`@hydranium/langium` loads. If you type-check first, `tsc` rejects your
generated modules with errors that name no cause, such as
`Types have separate declarations of a private property 'linker'`.

The files `langium-cli` generates import `langium` directly, so they run on the
instance your package resolves, and the framework runs on the one
`@hydranium/langium` resolves. Values Langium compares by identity, such as its
cancellation signal, are not recognised across two instances. The startup check
sees only the instance your generated code runs on, and misses it in a build
that mangles property names. A second copy that reaches the server another way,
such as one nested under another dependency, can show up instead as the
diagnostic `An error occurred during validation: Symbol(OperationCancelled)` on
a cancelled validation.

To see the copies installed and what requires each, run the following, adding
`-w <your package>` in a workspace to leave out the other members' copies:

```bash
npm explain langium
npm ls langium --all --parseable
```

The second lists one path per physical copy. Then find the cause:

- **Your package's `langium` resolves to another version.** A caret range can
  resolve past the version `@hydranium/langium` pins, and npm then
  nests the framework's copy beneath `@hydranium/langium` without a warning.
  Declare `langium` at that exact version, as `init` does, and reinstall from
  scratch. Pins take effect only on a from-scratch install; deleting the lockfile
  alone leaves stale nested copies behind:

  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```

- **Another workspace member's `langium` holds the top of the tree.** Your
  package then gets its own copy, and `@hydranium/langium` another, even at the
  same version, so pinning your package alone does not help. Declare the exact
  pins `init --monorepo` prints in the root's `devDependencies` as well: npm
  installs a root's own dependencies at the top of the tree, so the other
  member's version nests beneath that member instead. The pins include the LSP
  packages, which split the same way; see
  [the `ResponseError` entry](#a-responseerror-arrives-as-internalerror-or-as-a-result-or-an-instanceof-check-misses-it).
- **One install is loaded twice.** `npm ls` shows one copy, but a test runner or
  bundler that inlines `langium` and leaves `@hydranium/*` external, such as
  vitest with `langium` in `server.deps.inline`, gives your generated code its
  own instance. Load `langium` and `@hydranium/*` the same way: inline both, or
  neither.

The single-physical-copy requirement and the pinned chain it implies are stated
in [Requirements](requirements.md); bumping one link of that chain alone
reintroduces the split.

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
type-only from value imports.

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
connection wrapped the same way.
[Requirements](requirements.md#several-copies-of-vscode-jsonrpc-in-one-install)
has the detail. Do not pin `vscode-jsonrpc` or `vscode-languageserver-protocol`
in your root `overrides`: an override of `vscode-jsonrpc` forces GLSP's own copy
onto a version it cannot start with, and either one conflicts with the versions
`init` declares.

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
only when the framework shares that copy. Declare `vscode-jsonrpc` at the
exact version [Requirements](requirements.md) names, as `init` does.

Recognise errors with `isResponseError` and the `is…Error` guards from
`@hydranium/protocol` instead of `instanceof`, and throw a `ResponseError` from
the copy that built the connection the handler runs on.

A `ResponseError` a handler returns, rather than throws, from another copy
arrives as the request's result. Langium returns its errors, so an LSP request
for a missing document can resolve with `{"code":-32802}`. Declare
`vscode-languageserver` and `vscode-languageserver-protocol` at the exact
versions [Requirements](requirements.md) names, as `init` does, and reinstall
from scratch.

In a workspace, declare these pins in the root's `devDependencies` too, as
`init --monorepo` prints. Otherwise another member's LSP packages can hold the
top of the tree, and your package then gets copies of its own beside the
framework's.

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

## A diagram does not open, saying its identifier is in use

The diagram stays empty, and the user sees a message that the diagram's
identifier is still used by another editor, with `DIAGRAM_SESSION_REFUSED` as
its code.

Every diagram is a client session under its GLSP client id, and the server
already has a live session under that id. Usually it is the same diagram from
before a reload or a reconnect, and the server has not yet noticed its old
connection close. Hydranium's Theia client resumes such a session with a token
it keeps per window, so this happens when a client loads the diagram without
that token, or with another window's id.

**Remedy:** close the diagram and open it again once the old connection has
gone. A client of your own keeps the client id and resume token stable across
a reload, as the Theia client's `WindowSessionService` does.

## Semantic tokens add no colour in Theia

The server's semantic highlighting shows in VS Code but not in Theia, wherever
Theia runs the server; turning `editor.semanticHighlighting.enabled` on leaves
most names in the editor's default foreground.

This is a known limitation rather than a misconfiguration: Theia's themes have
no colours for semantic token types. The mechanism, and what a host can do about
it, are in
[Status and limitations](status.md#semantic-tokens-add-no-colour-in-theia).

## Still stuck

Server-side logging is the fastest way to see which hop stalled: every service
logs through the server's logger, and its level is a setting you can raise. A
client session shows in it as its label, a `#` and the first eight characters
of its UUID; starting and ending one logs its full id at trace level. If the log does not show it,
ask on the
[issue tracker](https://github.com/eclipse-emfcloud/hydranium/issues).
