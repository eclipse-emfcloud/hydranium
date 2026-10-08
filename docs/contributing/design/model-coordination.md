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
which hands each text change to the store. The layer generalises the LSP
document lifecycle to several clients:

- **The first open for a URI seeds the shared text**, and the server owns that
  text until the last client closes it. A later open attaches to the existing
  entry and never replaces its text with the caller's seed.
- **Between open and close, a client writes through its session.** The store
  advances the server-owned version and records the _author_ in its
  [`TextLedger`](../../../packages/core/src/documents/text-ledger.ts). The new
  state goes to every co-editing client tagged with that author, so each can
  apply or discard it, and update cycles are easy to avoid.
- **The text editor is updated through LSP `workspace/applyEdit`**, since it
  cannot subscribe to the store's listeners. A language-client shadow is the
  store's model of what the editor holds, which also tells the editor's echoes
  of those pushes apart from its own edits.
- **A successful update changes shared memory only**; the caller's `save`
  persists it. The one other disk writer is an integrity repair, routed as
  [How an integrity repair is
  routed](document-layers.md#how-an-integrity-repair-is-routed) describes.

Each transition is specified in [Transitions that change the
owner](document-layers.md#transitions-that-change-the-owner); what the last
close releases and keeps is in [Last close and
release](client-sessions.md#last-close-and-release).
