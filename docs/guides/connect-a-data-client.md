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

   A part of your UI that stays on a document calls `openDocument` once, then
   `updateDocument` for each edit and `saveDocument` when the user saves, and
   `closeDocument` when it is done. Every write names the version it is based
   on, and fails with a `ConflictError` when someone else has changed the
   document since; read it again and retry, or tell the user.

4. Ignore your own echoes. Every change reaches you as an update event, your
   own included; `session.isOwnEcho(event.sourceClientId)` tells you which ones
   you made yourself.

5. Show whether a document has unsaved changes. Every document the server sends
   carries `text.dirty`, and `DataEvents.onDidChangeDocumentDirty` tells you
   when it changes, whoever made the edit or the save.

6. End the session with `dispose()` when that part of the UI goes away. Any
   save still on its way reaches the server first. After that, every call on
   the session fails with `SessionClosedError`.

## When the connection drops

You don't have to do anything. When the connection comes back, each session
picks up where it left off: it reopens your documents, and if the server lost
your unsaved edits in the meantime, it sends them again. Only when someone else
changed a document while you were away does it leave that document alone and
tell the user their edits were lost, through your port's `reportError`.

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
