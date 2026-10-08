# Model coordination

How the heads share one document. The adopter's view is in
[How it works](../../concepts/how-it-works.md#documents-sessions-and-saves); the
contract per head is in [Client sessions](client-sessions.md),
and how text, AST and transfer form relate in
[The four document layers](../../concepts/document-layers.md).

## One store, one manager

The core is
[`HydraniumTextDocuments`](../../../packages/core/src/documents/hydranium-text-documents.ts),
the one text store every head writes to and the LSP text-sync endpoint: the
editor's `textDocument/*` notifications arrive there directly. The non-textual
heads open, update and save documents in AST terms through
[`AstDocumentManager`](../../../packages/core/src/documents/ast-document-manager.ts),
which hands each text change to the store. Sessions call the store only for
their lifecycle and open-state queries; editor pushes and integrity repairs
write through it directly. The layer generalises the LSP document lifecycle to
several clients:

- **The first `open` for a URI seeds the shared text**: from content an
  integrity repair staged for it, if any; otherwise from the text the client
  supplied, or from the filesystem when it supplied none. The server then owns
  that text until the last client closes it. An open for a URI already held
  attaches the new client to the existing entry without rebuilding it, and the
  data head's response reads a fresh snapshot of that entry. A textual
  `didOpen` attach can separately refresh the build. Neither path replaces the
  shared text with the caller's seed.
- **Between open and close, a client sends updates through its session**, which
  fail for a document the session does not have open. The `baseVersion` check
  runs before serialization or mutation, and again where the text applies. A
  successful change reaches the store through `AstDocumentManager.update`; the
  store advances the server-owned version and records the _author_ in its
  [`TextLedger`](../../../packages/core/src/documents/text-ledger.ts). The new
  state goes to every co-editing client tagged with that author, so each can
  apply or discard it, and update cycles are easy to avoid.
- **The text editor is updated through LSP `workspace/applyEdit`**, since it
  cannot subscribe to the store's listeners. This is the shadow path:
  [`LanguageClientShadow`](../../../packages/core/src/documents/language-client-shadow.ts)
  is the store's model of what the editor holds, which also tells the editor's
  echoes of those pushes apart from its own edits.
- **After the last client closes the document, the shared text and the editor
  shadow are released**, and only the content-version sequence is kept. The
  store hands the document to the
  [`DocumentReleaseHandler`](../../../packages/core/src/documents/document-release-handler.ts)
  slot, whose default rebuilds it from the filesystem provider for every head,
  or removes it from the workspace when the provider cannot serve it, whatever
  the URI's scheme. After a lost connection the release waits out the release
  grace (`releaseGraceMs`), within which a reconnecting client finds its unsaved
  text.

## The data head's sessions

A data client's `DataSession` is a client session registered over its
connection. It pairs `openModelDocument` with a `watchModelDocument`
subscription, and closing the document releases both. Disposing the session
ends it on the server, which closes everything it has open; a connection
shutdown ends every session on it from the server side, so teardown sends no
RPC over the closing wire.

If an open's snapshot fails, the open is closed again. If registering the watch
fails, the session closes the document it just opened. A close that fails
leaves the document open until the session ends.

## Saving

A session's `save` builds through the update path, then
`AstDocumentManager.save` writes the store's current text to disk only when it
differs. A successful update therefore changes shared memory only; the caller's
save is what persists it. The one other writer is an integrity repair in
`'silent'` sync mode. It writes a URI no client holds, and a URI held only
through the data or GLSP head when disk still holds the text the repair was
computed from, so it never carries an unsaved update; otherwise the repair stays
in the store until that save.
