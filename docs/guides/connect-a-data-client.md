# Connect a data client

Use this when your client reads and writes models over the data head: a form, a
property view, a tree, or a tool that drives the server over JSON-RPC. The rules
every writer follows are in
[How it works](../concepts/how-it-works.md#documents-sessions-and-saves).

Heads: data

## The seam

You talk to the data head through a `DataConnection` from
`@hydranium/protocol`. Each part of your UI that edits documents takes its own
`DataSession` on that connection. The session's id is how the server tells your
writes from everyone else's, and it owns what you have open: when the session
ends, its documents close.

## Steps

1. Open one connection for your page or process, over a `DataPort` for your
   transport: `new DataConnectionWithEvents(port)`. In Theia, bind it with
   `bindDataConnection` instead, as the
   [data-client-theia README](../../packages/data-client-theia/README.md#wiring)
   shows. When a second part of your UI needs the data head, give it a second
   session on the same connection, not a second connection: two connections on
   one port read each other's replies.

2. Start a session and name it after the part of the UI it serves:
   `connection.createSession('form')`. You can use it straight away; its calls
   wait until the server has registered it.

3. Open a document, write it, and close it again. When you only need to make
   one change, `withOpenDocument` does all three:

<!-- snippet-preamble
import { type TransferElement, TransferDocument } from '@hydranium/protocol';
import type { DataConnection } from '@hydranium/protocol/client';
declare const connection: DataConnection<TransferElement>;
declare const uri: string;
declare const model: string;
-->

```ts
const form = connection.createSession('form');
await form.withOpenDocument({ uri }, opened =>
   form.saveDocument({ uri, model, baseVersion: TransferDocument.assertLoaded(opened).model.version })
);
```

   A part of your UI that stays on a document, such as a form, can hand it to a
   `WorkingCopy` from `@hydranium/protocol`. Create one per document, `open`
   it, call `edit` with a change to the root, and `save` when the user saves.
   It sends an edit at once, and the edits made while a write is out as one
   write after it. It counts them as unsaved until the server answers, and
   reconciles a write that raced someone else's. Each edit resolves to how it
   went, so you can tell the user when theirs lost, and rejects when its write
   failed for another reason, as with a `DocumentSyntaxError`. To show another
   document, `close` it, `dispose` it, and create a new one. On the same
   session, open a copy of a document still closing only once that close has
   settled, or the close ends the new open too. The order-flow example's
   properties model builds on it, in
   `examples/order-flow/client/src/data/order-flow-properties-model.ts`, and
   `examples/order-flow/client/src/properties/properties-documents.ts`
   switches documents this way.

   Without it, call `openDocument` once, then `updateDocument` for each edit
   and `saveDocument` when the user saves, and `closeDocument` when you are
   done. Every write names the version it is based on, and fails with a
   `ConflictError` when someone else has changed the document since. Read it
   again and retry, or tell the user. A write of a model also fails, with
   `DocumentSyntaxError`, while the document's last build has a syntax error,
   since the model would replace what the parser skipped. A blank document
   takes the write. Write text to repair it. To tell before writing, pass the
   document's diagnostics to `TransferDiagnostic.hasSyntaxErrors`. It is a
   hint only, since the diagnostics can lag the build or miss an error.

4. Ignore your own echoes. A `WorkingCopy` does this for you. Without one,
   every change reaches you as an update event, your own included.
   `session.isOwnEcho(event.sourceClientId)` tells you which ones you made
   yourself.

5. Show whether a document has unsaved changes. A `WorkingCopy` tells you
   through `dirty` and `onDidChangeDirty`. Without one, every document the
   server sends carries `text.dirty`, and
   `DataEvents.onDidChangeDocumentDirty` tells you when it changes, whoever
   made the edit or the save.

6. End the session with `dispose()` when that part of the UI goes away. Any
   save still on its way reaches the server first. After that, every call on
   the session fails with `SessionClosedError`. Wait for a `WorkingCopy`'s
   `whenWritesSettled()` before that, or the edits it has not yet sent are
   never sent. Ending the session closes its documents on the server. A
   `close()` would wait for the writes too, and for an open still under way,
   within the same bound, but then sends a close request, which a server that
   never answers leaves pending.

## When the connection drops

When the connection comes back, each session picks up where it left off: it
reopens your documents, and if the server lost your unsaved edits in the
meantime, it sends them again. Only when someone else changed a document while
you were away does it leave that document alone and tell the user their edits
were lost, through your port's `reportError`.

A `WorkingCopy` on a connection that hears deletions, such as
`DataConnectionWithEvents`, needs nothing more from you. Without one, listen to
`session.onDidRestoreDocument`, which fires for each document the session opened
again, or could not. A document deleted while the connection was down gets no
restore event: you hear of it as a deletion when you listen for one, and
otherwise its unsaved text is reported lost. No update event tells you of a
change made while the connection was down, and a restarted server numbers
versions afresh, so take the document and its version from the event, or read
the document again when the event carries none. Treat a document whose event
says `reopened: false` as closed. A write gated on a version that you made
before the event, and that waited for the reconnect, fails with a
`ConflictError`, unless the session found the text it last saw at that
document's version. One gated on `'any'` is sent. One you make after it with a
version you kept is sent, and lands if that version matches the new numbering by
chance.

How long the server keeps your unsaved text after a drop is its
`releaseGraceMs`, an option of `HydraniumTextDocuments` in the server's shared
module. A client that is back within it finds its edits still there.

## In Theia

`bindDataConnection` also makes Theia end your sessions when the page closes,
so the server lets go of their documents at once. While a save is still on its
way, it holds the page open: Electron waits for the save, and a browser asks the
user before leaving.

## Without the client library

A client written in another language speaks the protocol directly. Register a
session with `createSession({ clientId, label })`, and send that `clientId` on
every document request: the server treats each request as that session's.
Wait for a save's answer before you send the close, or the save fails because
the document is no longer open.

## Going further

[Client sessions](../contributing/design/client-sessions.md) describes exactly
what the server does with each request, and how a reconnect decides what to
send again.
