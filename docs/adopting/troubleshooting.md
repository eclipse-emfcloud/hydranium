# Troubleshooting a server you are building

These failures are hard to diagnose because the message names the wrong layer.
Each entry starts with what you see, then the cause, then the remedy.

For what the framework does not do, as opposed to what has gone wrong, see
[Status and limitations](status.md).

## Startup rejects the AST reflection, or a cancelled validation reports `Symbol(OperationCancelled)`

You see one of these:

- At startup, the server throws a `[hydranium]` error saying your AST
  reflection extends `AbstractAstReflection` from another instance of `langium`
  than the one `@hydranium/langium` loads.
- `tsc` rejects your generated modules with an error that names no cause, such
  as `Types have separate declarations of a private property 'linker'`.
- A cancelled validation reports the diagnostic
  `An error occurred during validation: Symbol(OperationCancelled)`.

Your server runs two instances of `langium`. The files `langium-cli` generates
import `langium` directly, so they run on the copy your package resolves. The
framework runs on the copy `@hydranium/langium` resolves. Langium does not
recognise values such as its cancellation signal across the two. The startup
check sees only the copy your generated code runs on, so a copy nested under
another dependency shows up only as the cancelled-validation diagnostic.

**Remedy:** list the copies and what requires each. In a workspace, add
`-w <your package>` to leave out the other members' copies:

```bash
npm explain langium
npm ls langium --all --parseable
```

The second command lists one path per physical copy. Then fix the cause that
matches:

- **Your package's `langium` resolves to another version.** A caret range can
  resolve past the version `@hydranium/langium` pins. Declare `langium` at that
  exact version, as `init` does, and reinstall from scratch. Deleting the
  lockfile alone leaves stale nested copies behind:

  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```

- **Another workspace member's `langium` holds the top of the tree.** Your
  package and `@hydranium/langium` then each get their own copy, even at the
  same version. Add the exact pins `init --monorepo` prints to the root's
  `devDependencies` as well. They include the LSP packages, which split the
  same way; see
  [the `ResponseError` entry](#a-responseerror-arrives-as-internalerror-or-as-a-result-or-an-instanceof-check-misses-it).
- **One install is loaded twice.** `npm ls` shows one copy, but a test runner or
  bundler inlines `langium` and leaves `@hydranium/*` external, such as vitest
  with `langium` in `server.deps.inline`. Load `langium` and `@hydranium/*` the
  same way: inline both, or neither.

[Requirements](requirements.md) states the one-copy requirement and the pinned
chain behind it. Bumping one link of that chain alone splits the copies again.

## A framework fix disappears after you rebind a service

Completion stops inserting correctly, a scope stops resolving a name, or a
diagnostic stops appearing. It starts the moment you bind your own
implementation of that service. Your class compiles cleanly, and nothing logs
an error or a warning.

Your class extends the upstream base class where the framework binds its own
subclass, for example Langium's `DefaultCompletionProvider` instead of
`HydraniumCompletionProvider`. Both satisfy the slot's type, so nothing
complains, and your binding drops the framework's fixes.

**Remedy:** before you rebind a service, check whether the framework
specialises it, and extend that class instead:

- A `Hydranium*` class is the framework's version of an upstream Langium, GLSP
  or Theia class.
- A slot marked `/* override */` in a framework module has a specialisation,
  such as `/* override */ CompletionProvider: HydraniumCompletionProvider;` in
  `packages/core/src/lsp/language-module.ts`.

To list every specialisation the framework ships:

```bash
grep -rE '^export (abstract )?class Hydranium\w+ extends ' node_modules/@hydranium/*/src
```

Binding a class that does not derive from the framework's is supported. Make it
a decision, not an accident.

## `Unknown parameter structure auto`

You see one of these:

- `Unknown parameter structure auto` is thrown when a typed message, a
  `RequestType` or `NotificationType`, is sent over a raw `vscode-jsonrpc`
  connection, by your own code or by GLSP over a connection you handed it.
  GLSP's VS Code integration throws it even unchanged, because its
  `SocketGlspVscodeServer` creates the connection from the integration's own
  copy.
- In Theia, a GLSP diagram never receives a message, and the console shows
  `No runtime abstraction layer installed`.

The message and the connection come from two physical copies of
`vscode-jsonrpc`. An install holds several copies as a matter of course;
[Requirements](requirements.md#several-copies-of-vscode-jsonrpc-in-one-install)
explains why. The connections the framework creates or hands to GLSP already
send by method name, and so does the LSP connection.

**Remedy:**

- Wrap every connection you hand GLSP with `sendByMethodName` from
  `@hydranium/protocol`. For the VS Code integration, override its
  `createConnection`.
- Send your own messages by method string, or over a connection wrapped the
  same way.
- In Theia, make `@hydranium/glsp-client-theia` resolve the top-level copy that
  GLSP's Theia integration uses, not a nested one. It sets up only the copy it
  resolves.
- Do not pin `vscode-jsonrpc` or `vscode-languageserver-protocol` in your root
  `overrides`. An override of `vscode-jsonrpc` forces GLSP's own copy onto a
  version it cannot start with, and either one conflicts with the versions
  `init` declares.

## A `ResponseError` arrives as `InternalError` or as a result, or an `instanceof` check misses it

You see one of these:

- A handler throws a `ResponseError` with a code, and the caller receives
  `InternalError` with the message folded into
  `Request … failed with message: …`.
- An `instanceof ResponseError` check answers `false` for an error that plainly
  carries a code.
- An LSP request resolves with an error as its result, such as
  `{"code":-32802}` for a missing document.

This is the same split as above. A connection keeps a thrown `ResponseError`'s
code and data only when the error comes from the connection's own copy of
`vscode-jsonrpc`. `instanceof` recognises only the copy it was imported from.
A `ResponseError` that a handler returns from another copy arrives as the
request's result, and Langium returns its errors.

**Remedy:**

- Declare `vscode-jsonrpc`, `vscode-languageserver` and
  `vscode-languageserver-protocol` at the exact versions
  [Requirements](requirements.md) names, as `init` does, and reinstall from
  scratch.
- In a workspace, add the same pins to the root's `devDependencies`, as
  `init --monorepo` prints. Otherwise another member's LSP packages can hold the
  top of the tree, and your package gets copies of its own.
- Recognise errors with `isResponseError` and the `is…Error` guards from
  `@hydranium/protocol`, not with `instanceof`.
- Throw a `ResponseError` from the copy that built the connection the handler
  runs on.

## `MethodNotFound` on `workspace/applyEdit`, or a server-side write that never appears

A write made on the server, such as a diagram operation or an integrity repair,
does not show up in your client's editor, and nothing obviously fails.

A server-side change to an open document goes to the client as a
`workspace/applyEdit` request, whatever capabilities the client declared. A
client that sends `didOpen` but handles no `applyEdit` answers
`MethodNotFound`. The framework logs that over `window/logMessage`, so a client
that does not handle that either loses the failure in silence.

**Remedy:** handle both in your client. Apply each `workspace/applyEdit` to your
editor's model, and show `window/logMessage` where a developer will see it. A
host that only reads documents and never displays them still needs the second.

## A diagram does not open, saying its identifier is in use

The diagram stays empty, and the user sees "Could not open this diagram: its
identifier is still in use by another editor." The message is
`DIAGRAM_SESSION_REFUSED`.

The server still holds a live session under the diagram's GLSP client id.
Usually it is the same diagram from before a reload or a reconnect, and the
server has not yet seen the old connection close. Hydranium's Theia client
resumes such a session with a token it keeps per window. So this happens when a
client loads the diagram without that token, or with another window's id.

**Remedy:** close the diagram and open it again once the old connection has
gone. If you write your own client, keep the client id and the resume token
stable across a reload, as the Theia client's `WindowSessionService` does.

## Semantic tokens add no colour in Theia

The server's semantic highlighting shows in VS Code but not in Theia, wherever
Theia runs the server. Turning `editor.semanticHighlighting.enabled` on leaves
most names in the editor's default foreground.

Theia's themes have no colours for semantic token types. This is a known
limitation, not a misconfiguration.

**Remedy:** see
[Status and limitations](status.md#semantic-tokens-add-no-colour-in-theia) for
what a host can do about it.

## Still stuck

Server-side logging is the fastest way to see which hop stalled. Every service
logs through the server's logger, and you can raise its level. A client session
shows in the log as its label, a `#` and the first eight characters of its
UUID. Starting and ending a session logs its full id at trace level. If the log
does not show the problem, ask on the
[issue tracker](https://github.com/eclipse-emfcloud/hydranium/issues).
