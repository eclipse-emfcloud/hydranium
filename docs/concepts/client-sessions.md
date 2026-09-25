# Client sessions

A client session is one participant working on documents: a form, a property
view, a diagram, a script. It is identified by one client id, and that id is at
once the author label on its writes, the key it recognises its own echoes by,
and the owner of every document it has open. A session opens what it works on,
writes only what it has open, and ending it closes everything it has open.

## Starting a session

<!-- snippet-preamble
import type { ServerSharedServices } from '@hydranium/core';
declare const shared: ServerSharedServices;
-->

```ts
const session = shared.model.ModelService.createSession('form');
```

`ModelService.createSession(label?, clientId?)` is synchronous. The id defaults
to the label, a `#` and a random UUID, such as `form#3f2b…`; without a label the
label is `session`. A fixed id is taken as given:
`createSession('form', 'form-1')`.

An id is unique in the process while its session is live. `createSession` throws
`DuplicateClientIdError` for an id that is live anywhere in the process: one
another live session holds, one a client that is not a session has documents
open under, and the ids in `RESERVED_CLIENT_IDS`, which the framework keeps for
its own participants. Once a session has ended its id is free again.

`ModelService.getSession(id)` returns the live session started under `id`, and
`undefined` once it has ended, so a request handler or a server subclass can act
as the caller whose id arrived with the request.

To use a session class of your own, override `DefaultModelService.newSession`
and narrow its return type. `createSession` registers the id and checks it
before `newSession` runs, so an override cannot skip either.

## The handle

| Member | Meaning |
| --- | --- |
| `open(uri, options?)` | Open `uri` for this session, reading it from disk unless some client has it open |
| `create(uri, text)` | Create a document with `text` and open it; fails if the file exists or any client, the session included, has the URI open |
| `update(args)` / `save(args)` | Write, or write and persist; fail with `DocumentNotOpenError` unless this session has the URI open |
| `updateAll({ updates })` | Write several documents the session has open, all or none |
| `close(uri)` | Close this session's open of `uri` |
| `withOpen(uri, fn)` | Open, run `fn`, and close again when `fn` settles, unless the session already had `uri` open |
| `isOwnEcho(sourceClientId)` | Whether an event's `sourceClientId` is this session's id |
| `dispose()` | End the session: close everything it has open and free its id |

`update` and `save` take the same arguments as `ModelService.update` and
`ModelService.save`, without `clientId`: the session supplies its own.

## Open and close

A session has a URI open once, with no reference count. Opening a URI it already
has open changes nothing, and one `close` ends the open however many times it
was opened. Two participants that each need a document open use two sessions.

`close` takes effect at once. Closing a URI the session does not have open does
nothing.

`options` is an object of fields your own open path reads, kept for that open
until it closes. It is stored per session and URI, so two sessions opening one
document keep their own; a repeat open keeps the options of the first, and so
does a second open issued while the first is still under way, which joins it.
Read them back with `TextDocuments.openOptions(uri, clientId)`. To type them,
pass the type when starting the session:
`createSession<{ mode: string }>('form')`.

## Writes need an open

A session's `update` and `save` never open a document. They fail with
`DocumentNotOpenError`, which carries the `uri` and the `clientId`, unless the
session has the URI open at the moment the text is applied. The check and the
apply are one synchronous step, so a write either lands while the document is
open or fails: a session that sends an update and then closes the document
before the update applies gets `DocumentNotOpenError` for the update, and the
document is not reopened behind it.

The `basedOn` gate works as it does for any write, and a stale write still fails
with `ConflictError`. It is checked again in the step that applies the text, so
of two writes based on one version, the second fails. An integrity repair of an
open document is a new version authored by `integrity`: a write based on the
version before the repair fails, and `isOwnEcho` is false for the update that
carries the repair.

A save persists the document's current text, which includes unsaved edits other
participants have made to it: there is one shared text per document. The save
checks the open once more when it takes that text, after the rebuild: a session
that closes the document while it is being built gets `DocumentNotOpenError`,
and nothing is written. Once the text is taken, the write completes even if the
session closes the document or ends.

## `updateAll`

`updateAll({ updates })` writes several documents in one step. Every document is
serialised first; then the open check and the `basedOn` gate run for every
document and every text applies, in one synchronous step. A `ConflictError` or
`DocumentNotOpenError` for any document of the set is thrown before any text
applies, so a set never ends half-written. It resolves to the rebuilt
documents in the order given, and refuses a set that names one document twice.
`ModelService.updateAll({ clientId, updates })` does the same for any client
id: it opens nothing, so the id must have every URI open.

The step relies on `AstDocumentManager.update` applying its text before its
first await, as the framework's does. An override that awaits before applying
lets another write land between two documents of the set.

## Writes by a client id that is not a session

`ModelService.update` and `ModelService.save` called with a client id that is
not a live session keep their older behaviour. They open the document for that
id first, and create it from the payload when no file exists; nothing closes
that open until the caller does.

## Errors on the wire

`SessionClosedError`, `DocumentNotOpenError` and `DuplicateClientIdError` are
defined in `@hydranium/protocol` and re-exported from `@hydranium/core`. Like
`ConflictError`, each is a JSON-RPC `ResponseError` with its own code
(`SESSION_CLOSED_ERROR_CODE`, `DOCUMENT_NOT_OPEN_ERROR_CODE`,
`DUPLICATE_CLIENT_ID_ERROR_CODE`) and its fields in `data`, since the class
does not survive the trip to a client and the code, message and data do. A
client recognises them with
`isSessionClosedError`, `isDocumentNotOpenError` and `isDuplicateClientIdError`,
never with `instanceof`.

## Over the data head

A data-server connection registers sessions with `createSession({ clientId,
label })`, which fails with the `DuplicateClientIdError` code for an id live
anywhere in the server process. The one exception is `resumeToken`: a
registration carrying the token an earlier registration of the same id carried
ends that session, as its connection closing would, and registers the id
afresh. It lets a client whose connection dropped register again before the
server has noticed the drop. The token guards against colliding with that
session; it is not a secret, since the wire carries no authentication, and a
takeover ends the old session even when its connection is still alive.

The session belongs to the connection: a request carrying its id acts as that
session, so its `updateModelDocument` and `saveModelDocument` write only what
it has open and open nothing. `openModelDocument` opens for the session,
keeping the request's `options` as the open's options; a session's open takes
no `languageId`, `version` or `text` seed: it reads the file, or joins the text
another client already has open.
`closeModelDocument` closes the session's open and its watch.

`createModelDocument({ uri, clientId, text })` and
`updateModelDocuments({ clientId, updates })` exist for sessions only; they are
`create` and `updateAll` over the wire, and fail with the `SessionClosedError`
code, and a message saying so, for an id the connection never registered.

`closeSession({ clientId })` ends the session: it closes everything the session
has open, drops its watches on the connection, and frees the id. When the
connection closes, every session it registered ends the same way. Either way a
later request under the id from that connection fails rather than opening
anything, until the connection registers the id again. A request carrying an
id that is not a registered session keeps the per-client behaviour described
above.

## `DataSession`

On the client, `DataConnection.createSession(label?, clientId?)` returns a
`DataSession`, the client side of such a session. It is synchronous: the id
defaults to the label, a `#` and a random UUID, the registration is sent at
once, and every call of the session waits for it. When the server refuses the
registration, every call of the session rejects with its error. A fixed id is
taken as given; the framework's reserved ids and an id another live session on
the connection holds are refused at once.

<!-- snippet-preamble
import type { TransferElement } from '@hydranium/protocol';
import type { DataConnection } from '@hydranium/protocol/client';
declare const connection: DataConnection<TransferElement>;
declare const uri: string;
declare const model: string;
-->

```ts
const form = connection.createSession('form');
await form.withOpenDocument({ uri }, opened => form.saveDocument({ uri, model, basedOn: opened.version }));
```

| Member | Meaning |
| --- | --- |
| `openDocument(args)` | Open and watch the document, in that order, returning the opened snapshot |
| `createDocument({ uri, text })` | Create a document open and watched for the session |
| `updateDocument(args)` / `saveDocument(args)` | Write, or write and persist, a document the session has open |
| `updateDocuments({ updates })` | Write several documents the session has open, all or none |
| `closeDocument(args)` | Close the document and its watch |
| `withOpenDocument(args, fn)` | Open, run `fn` with the snapshot, and close again, unless the session already had the document open |
| `isOwnEcho(sourceClientId)` | Whether an event's `sourceClientId` is this session's id |
| `dispose()` | End the session on the server, which closes everything it has open |
| `reconnect()` | After the connection dropped, register again and restore now rather than on the next call; the connection calls it for every session with documents open |

`closeDocument` and `dispose` first wait for the session's calls still in
flight on the document, or on any document for `dispose`, up to ten seconds, so
a save sent just before a close reaches the server first. A client that
registers a session without `DataSession` and sends a close without awaiting
its save gets the `DocumentNotOpenError` code for the save.

When the connection drops, the connection registers every session with
documents open again at once, under the same id and with the resume token the
session has kept since it was created, so the server ends the old session if
it has not noticed the drop yet. A session with nothing open registers again
on its next call. The session then re-opens and re-watches every document it
had open. It does not send its unsaved edits again:

- A document whose re-opened version is the version the session's last write
  was answered with still holds that write, and nothing is reported.
- Any other version means the document's version moved on since the
  session's last unsaved write: another client edited it, even while the
  session was still connected, the server reverted it to disk when the
  session's open closed as the document's last, or the server restarted. The
  session reports these documents once, through the connection's error sink,
  with the message `DATA_SESSION_UNSAVED_LOST`, and forgets their unsaved
  edits; they stay open.

A document that cannot be re-opened is reported with the message
`DATA_SESSION_RESTORE_FAILED`, and forgotten. Where the server reverts a
document on its last close, it does so at once on a lost connection too, so a
session that was a document's only client loses its unsaved edits in any
reconnect, and is told so.

To hand out a subclass of `DataSession`, pass `sessionFactory` in the
connection's options.

## Disk writes

Every disk access of a file the framework makes on the server goes through one
queue per file, whichever session, head or service makes it. Each save takes
its text when it is called and writes in the order it was called, so the file
ends with the newest saved text. Files do not wait for one another, and updates
do not wait for the queue. A build waits only for its own repair write, which
queues behind earlier saves of that file.

Code of your own that writes a file the framework also saves runs its write
through `AstDocumentManager.queueDiskTask` to stay in that order. The task must
not await a build, a save, another queued task or an open of a document no
client has open, for the same file: what it waits for queues behind it, and the
file's queue stops for good.

With `coalesceSaves` set in `AstDocumentManagerOptions`, a save still waiting
behind another is skipped when a newer save of the same file queues behind it.
The skipped save announces nothing and takes the newer save's outcome: it
resolves when that one lands, and rejects with its error when it fails. The
framework binds the manager without options, so turning this on means binding
`AstDocumentManager` to a `DefaultAstDocumentManager` constructed with them.

The language server reverts a file to what is on disk when its last client
closes it. The revert waits for the file's queue to drain first, so a save
issued before the close is not reverted past; a client that opens the file
meanwhile keeps its text, and no revert follows.

## `withOpen`

`withOpen(uri, fn)` opens `uri`, runs `fn`, and closes `uri` once `fn` has
returned or thrown. The close undoes only the open `withOpen` made: a URI the
session already had open, or was still opening through another call, stays open
afterwards. It suits a one-shot write to a document the session does not
otherwise work on:

<!-- snippet-preamble
import type { ClientSession } from '@hydranium/core';
import type { AstNode } from '@hydranium/langium';
import type { SnapshotVersion } from '@hydranium/protocol';
declare const session: ClientSession<AstNode>;
declare const uri: string;
declare const model: string;
declare const basedOn: SnapshotVersion;
-->

```ts
await session.withOpen(uri, () => session.save({ uri, model, basedOn }));
```

## `create`

`create(uri, text)` fails when a file exists at `uri`, or when any client, the
session itself included, has the URI open, including a client whose open lands
while the create is under way: of two creates of one URI, at most one succeeds.
Otherwise it opens a document holding `text` for the session. The document
exists in memory only; it reaches disk with the first `save`.

## Ending a session

`dispose()` closes every document the session has open, each through the
ordinary close, and frees the id, all before it returns. A second `dispose()`
does nothing. Every other member throws `SessionClosedError` from then on,
synchronously, before returning a promise.

An `open` or `create` still in flight when the session ends is rejected with
`SessionClosedError`, and leaves nothing open. The exception is an id taken
again meanwhile: opens are keyed by id, so the new session under that id keeps
the open and releases it when it ends.

`TextDocuments.onDidCloseSession` fires once a session has ended, after its
opens have closed.

## Deletion

When a build reports a file deleted, every open of that file closes, except the
editor's: an editor keeps the buffer of a deleted file and goes on sending
changes for it. A session that writes the file afterwards gets
`DocumentNotOpenError`.

A subclass calling `TextDocuments.delete(uri)` closes every open of the URI, the
editor's included, before the document is removed.

## Reads need no session

Reads take no session and live on `ModelService`: the phase reads and the waits
beside them, `snapshot`, `getDocument`, `isOpen` and the `on…` subscriptions.

## One LSP connection per server process

The LSP head is one participant with the fixed id `language-client`, which is
why no session can take that id. Langium binds one LSP connection to a
shared-services tree, and the language-client state the text store keeps is
keyed by URI alone, so a server process serves one LSP connection.

## Logs

Log lines cut a client id eight characters after its last `#`, so a minted
session id prints as its label, the `#` and the first eight characters of the
UUID, which is enough to tell sessions apart; an id without `#` prints whole.
Starting and ending a session also log the full id at trace level.
