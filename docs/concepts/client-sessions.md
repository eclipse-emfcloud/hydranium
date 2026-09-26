# Client sessions

A client session is one participant working on documents: a form, a property
view, a diagram, a script. It is identified by one client id, and that id is at
once the author label on its writes, the key it recognises its own echoes by,
and the owner of every document it has open. A session opens what it works on,
writes only what it has open, and ending it closes everything it has open.

Every open and every write through `ModelService` goes through a session; the
service itself has no open, update or save.
The editor behind the LSP head is the one participant without a session: it
opens and edits over its connection under the reserved id `language-client`.

## Starting a session

<!-- snippet-preamble
import type { ServerSharedServices } from '@hydranium/core';
declare const shared: ServerSharedServices;
-->

```ts
const session = shared.model.ModelService.createSession('form');
```

`ModelService.createSession(label?, clientId?)` is synchronous. Pass a label
naming the participant. The id defaults to the label, a `#` and a random UUID,
such as `form#3f2b…`; without a label the label is `session`. A fixed id is
taken as given: `createSession('form', 'form-1')`.

An id is unique in the process while its session is live. `createSession` throws
`DuplicateClientIdError` for an id that is live anywhere in the process: one
another live session holds, or one a client that is not a session has documents
open under. Once a session has ended its id is free again. It throws
`ReservedClientIdError` for an id in `RESERVED_CLIENT_IDS`, which the framework
keeps for its own participants and which never frees up.

`ModelService.getSession(id)` returns the live session started under `id`, and
`undefined` once it has ended, so a request handler or a server subclass can act
as the caller whose id arrived with the request.

To use a session class of your own, bind a `ClientSessionFactory` on
`model.ClientSessionFactory` whose `create(clientId, label)` returns it.
`createSession` registers the id and checks it before it calls the factory, so a
factory cannot skip either. The framework's `DefaultClientSessionFactory` takes
the `slowUpdateWarnMs` option: when it is set, a session's `update` that takes
at least that many milliseconds logs a warn line. A factory that builds its
sessions without that threshold loses the warn line, so a session class of your
own keeps it by subclassing `DefaultClientSessionFactory` and building the
session as `new MySession(this.services, { ...this.options, clientId, label })`,
the `ClientSessionOptions` the default passes. A session logs under the
factory's `logName`, `ClientSession` when none is set, with its client id in a
bracket of its own.

`DefaultClientSession` opens and writes itself: each member hands its work to a
protected method (`registerOpen`, `createDocument`, `updateDocument`,
`updateDocuments`, `saveDocument`, `closeDocument`), and a session class of
your own overrides one of them to change how its sessions open or write. `save`
writes through `updateDocument`, so an override of it applies to saves too. The
open check and the `basedOn` gate are the session's own `assertOpen` and
`assertBasedOn`. Turning a model into text (`modelToText`) and `rebuild` live on
the `ModelService` bound on `model.ModelService`, which the session writes
through.

## The handle

| Member | Meaning |
| --- | --- |
| `open(uri, options?)` | Open `uri` for this session, reading it from disk unless some client has it open |
| `openOptions(uri)` | The options this session opened `uri` with |
| `create(uri, text)` | Create a document with `text` and open it; fails if the file exists, any client, the session included, has the URI open, or the URI waits out the revert grace |
| `update(args)` / `save(args)` | Write, or write and persist; fail with `DocumentNotOpenError` unless this session has the URI open |
| `updateAll({ updates })` | Write several documents the session has open, all or none |
| `close(uri)` | Close this session's open of `uri` |
| `withOpen(uri, fn)` | Open, run `fn`, and close again when `fn` settles, unless the session already had `uri` open |
| `isOwnEcho(sourceClientId)` | Whether an event's `sourceClientId` is this session's id |
| `dispose(cause?)` | End the session: close everything it has open and free its id |

`update` and `save` take `ClientSessionWriteArgs` (`uri`, `model`,
`basedOn`), and `updateAll` takes a `ClientSessionUpdateAllArgs` whose
`updates` lists them: the session supplies its own client id. The data
protocol's requests carry `clientId`; the data server maps each to a session
call.

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
Read them back with the session's `openOptions(uri)`. To type them,
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

The step relies on `AstDocumentManager.update` applying its text before its
first await, as the framework's does. An override that awaits before applying
lets another write land between two documents of the set.

## Errors on the wire

`SessionClosedError`, `DocumentNotOpenError`, `DuplicateClientIdError` and
`ReservedClientIdError` are defined in `@hydranium/protocol` and re-exported
from `@hydranium/core`. Like `ConflictError`, each is a JSON-RPC `ResponseError`
with its own code (`SESSION_CLOSED_ERROR_CODE`, `DOCUMENT_NOT_OPEN_ERROR_CODE`,
`DUPLICATE_CLIENT_ID_ERROR_CODE`, `RESERVED_CLIENT_ID_ERROR_CODE`) and its
fields in `data`, since the class does not survive the trip to a client and the
code, message and data do. A client recognises them with
`isSessionClosedError`, `isDocumentNotOpenError`, `isDuplicateClientIdError`
and `isReservedClientIdError`, never with `instanceof`. All but
`ReservedClientIdError` carry a message identity, so the data server renders
their sentence in the reader's locale where the adopter supplied a catalogue.

## Over the data head

A data-server connection registers sessions with `createSession({ clientId,
label })`, which fails with the `ReservedClientIdError` code for a reserved id
and with the `DuplicateClientIdError` code for an id live anywhere in the
server process. The one exception to the second is `resumeToken`: a
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
connection closes, every session it registered ends the same way, as lost
rather than closed, which lets the documents it was the last to have open wait
out the revert grace (see [Last close](#last-close)); so does a session another
connection takes over with its resume token. Either way a later request under
the id from that connection fails rather than opening anything, until the
connection registers the id again.

Every document request acts as a session, and one carrying an id the connection
never registered fails with the `SessionClosedError` code. A head that serves
the data protocol therefore implements sessions; the conformance kit seeds its
fixtures through them. Watching needs no session.

## `DataSession`

On the client, `DataConnection.createSession(label?, clientId?)` returns a
`DataSession`, the client side of such a session. Pass a label here too. It is
synchronous: the id defaults to the label, a `#` and a random UUID, the
registration is sent at once, and every call of the session waits for it. When
the server refuses the registration, every call of the session rejects with its
error. A fixed id is taken as given; an id in `FRAMEWORK_CLIENT_IDS` is refused
at once with a `ReservedClientIdError`, and an id another live session on the
connection holds with a `DuplicateClientIdError`. `isReservedClientIdError` and
`isDuplicateClientIdError` recognise these and the server's refusals alike.

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
| `onDidDispose` | Fires once when the session ends, by its `dispose()` or its connection's `dispose()`; a listener subscribed after that is never called, so check `isDisposed` first |
| `hasSavesInFlight` / `whenSavesSettled()` | Whether a save has not answered yet, and a promise for when the saves in flight now have, up to ten seconds |
| `reconnect()` | After the connection dropped, register again and restore now rather than on the next call; the connection calls it for every session with documents open |

`closeDocument` and `dispose` first wait for the session's calls still in
flight on the document, or on any document for `dispose`, up to ten seconds, so
a save sent just before a close reaches the server first. A client that
registers a session without `DataSession` and sends a close without awaiting
its save gets the `DocumentNotOpenError` code for the save.

After `dispose()` every call of the session rejects with `SessionClosedError`,
the error the server answers a call on an ended session with, so a caller
handles both alike. Its sentence names no client id, and it carries the
message identity `SESSION_CLOSED`. `onDidDispose` fires as soon as the session
rejects calls, before its end reaches the server; by then the connection has
let go of the session, so a listener may start one under the same id on that
connection. The server still holds the id until the old session's close
arrives, and refuses the new session's registration before then. When the
connection itself is disposed, it detaches its sessions instead, which sends
nothing: the server ends every session of a connection it sees close.

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
`DATA_SESSION_RESTORE_FAILED`, and forgotten. A session that was a document's
only client keeps its unsaved edits across a reconnect only when it re-opens
the document within the server's revert grace, ten seconds by default; after
that the document has reverted, and the session loses its unsaved edits and is
told so.

To hand out a subclass of `DataSession`, pass `sessionFactory` in the
connection's options.

### In Theia

A Theia frontend binds `DataSessionStopContribution` from
`@hydranium/data-client-theia/browser` as a `FrontendApplicationContribution`
and calls its `track(connection)` once for each data connection, which takes in
the sessions the connection has and every one it starts. When the page stops, it
disposes every tracked session, so the server ends them as closed, and each
document one of them was the last to hold reverts at once; otherwise the server
sees the page go only when its connection does, which Theia may hold open for
its reconnect timeout, and then ends them as lost. A session with a call still
in flight at the stop sends its close only after that call, too late for a page
going away, so it too ends as lost. While a tracked session has a save in
flight, it vetoes the stop: Electron waits for the saves, and a browser shows
its leave-page prompt. The Theia backend's forwarders send what the frontend
wrote before its channel closed, so a close sent as the page goes normally
arrives. The close is best effort all the same: under load the page's last
frames can be lost on the way, and the server then ends the sessions as lost.

## Over the GLSP head

Each GLSP client session is one client session. `HydraniumGlspStorage`
registers the GLSP client id as its id when the GLSP client session starts,
taking the id as given, and hands the session to the diagram's state as
`modelSession`. GLSP's placeholder client, `TEMPORARY_CLIENT_ID`, which exists
only to enumerate action kinds, registers nothing.

A GLSP client id can still be live as another participant's: a reloaded client
reconnects under its old id before the server has noticed the old connection
close, which ends that connection's sessions a moment later. The storage then
registers nothing when its GLSP session starts, and registers again when the
diagram loads; while the id is held, the load waits up to two seconds
(`sessionWaitMs`) for its holder to end. When the id is still held after that,
the diagram does not load: the client gets a rejection naming the id, and the
user a message saying the diagram's identifier is in use, with
`DIAGRAM_SESSION_REFUSED` as its code. A save of such a diagram fails the same
way. Taking the id over would end the other participant's session, and working
without one would share its opens, so its close would close the diagram's
documents too.

The diagram opens its source document through the session when it loads, and
every document of its write set (`trackSecondaryDocument`) as the document
joins. A document that leaves the write set stays open until the diagram's next
save, which saves it and then closes it, so leaving never reverts the diagram's
unsaved edits to it. Disposing the storage, when the GLSP client session ends,
the diagram's client detaches or the storage finds its GLSP session gone, ends
the session, which closes everything it has open.

`ReconcilingMultiDocumentGlspState` writes the documents of the write set that
changed in one `updateAll` on the session, so a conflict on any of them leaves
every one as it was. Each is gated: the source document on the `basedOn` the
recording command took, each other document on `secondaryBasedOn`, by default
the version it had when the source root was last read. Override
`secondaryBasedOn` to return `'anything'` to force a document's writes. A
conflict on any document goes to the state's conflict resolver for the whole
set, and a write based on `'anything'`, which a merged retry and an undo or
redo pass, forces every document. Before writing, the state opens each document
of the set through `openForWrite`; a state whose write set can name a document
that does not exist yet overrides it to `create` the document, since the
session's writes open nothing. The single-document states write through the session's
`update`. Every state refuses to write without a session, so a write after the
diagram ended fails.

A save persists the text of every document the session has open: the source
document, the write set, and the documents that left the write set since the
last save. A document only another client has open is not saved. Every save
takes its text in one step, so a GLSP client session that ends during the save
closes nothing before its text is taken.

A write to a document outside the write set goes through the session's
`withOpen`, based on the version `ModelService.snapshot` returned when the
element was read. A new file goes through `create`:

<!-- snippet-preamble
import type { AbstractHydraniumGlspState } from '@hydranium/glsp-server';
import type { AstNode } from '@hydranium/langium';
import type { SnapshotVersion } from '@hydranium/protocol';
declare const state: AbstractHydraniumGlspState<AstNode>;
declare const uri: string;
declare const model: string;
declare const basedOn: SnapshotVersion;
-->

```ts
const session = state.modelSession;
if (session) {
   await session.withOpen(uri, () => session.update({ uri, model, basedOn }));
}
```

## Disk writes

Every disk access of a file the framework makes on the server goes through one
queue per file, whichever session, head or service makes it. Each save takes
its text when it is called and writes in the order it was called, so the file
ends with the newest saved text. Files do not wait for one another, and updates
do not wait for the queue. A build waits only for its own repair write, which
queues behind earlier saves of that file.

Code of your own that writes a file the framework also saves runs its write
through `FileSystemTaskQueue.enqueue`, the shared service at
`workspace.FileSystemTaskQueue`, to stay in that order. The task must not await
a build, a save, another queued task or an open of a document no client has
open, for the same file: what it waits for queues behind it, and the file's
queue stops for good.

With `coalesceSaves` set in `AstDocumentManagerOptions`, a save still waiting
behind another is skipped when a newer save of the same file queues behind it.
The skipped save announces nothing and takes the newer save's outcome: it
resolves when that one lands, and rejects with its error when it fails. The
framework binds the manager without options, so turning this on means binding
`AstDocumentManager` to a `DefaultAstDocumentManager` constructed with them.

## Editor saves

An editor behind the LSP head writes the file itself; the server hears of the
save through `willSaveWaitUntil` before the write and `didSave` after it, and
advertises both. The editor's save joins the file's disk queue:

- The answer to `willSaveWaitUntil`, which carries no edits, waits for the
  server's writes of the file already queued, so the editor writes after them.
- From the moment the queue reaches the editor's save, a server write of the
  file queued behind it waits for the editor's `didSave`, so it lands after
  the editor's write.

Each wait is capped by `willSaveGateMs` in
`HydraniumDocumentUpdateHandlerOptions`, default 1000 ms. An answer whose cap
runs out is logged at warn level. A `didSave` that does not come within the cap
is logged at debug level only, since an editor sends none for a save it
cancels or that changed nothing. The answer never fails: VS Code gives up on
an answer after about 1.5 s, and stops asking for the rest of the session once
four answers, over all documents, timed out or failed; Theia waits without a
limit. Langium drops the request's cancellation, so an answer the editor
stopped waiting for still waits out its cap.

`didSave` fires `TextDocuments.onDidSaveInLanguageClient` for every editor
save, which releases the hold. The store then reads the file back through its
disk queue, after any server write queued behind the hold. Only when it holds
the document's current text does the store fire `onDidSave` under
`language-client`, as any save does under its client's id, and the data head
broadcasts it as a save. The editor saves its own buffer, which lags the store
while another client's edit is on its way to it; the file, not the editor,
tells whether the shared document is on disk, and a check of the file needs no
saved text from the client. When the file differs, or cannot be read, the save
reached disk only and no `onDidSave` fires. A file changed again between the
editor's write and the read also counts as differing.

## Dirty state

For each document a client has open, the text store keeps the text the server
last knew the file to hold, and `TextDocuments.isDirty(uri)` answers whether
the document's text differs from it. That text moves only where the server
reads or writes the file:

- a first open takes the text it opened with: the file for a session, the
  buffer for an editor. `create`, and any open given its text, has no file, so
  such a document is dirty until its first save, and a document opened on
  content the integrity service staged is dirty too;
- a server save takes the text it wrote, or found the file already holding;
- an editor save takes the file the store reads back, whether or not it holds
  the document's text;
- a watched-file change the server did not write takes the file, read through
  its disk queue, and no file when it cannot be read;
- an integrity repair written to a file some client holds takes the repair.

A document released after its last close is not dirty, and a dirty one
announces the change. `TextDocuments.onDidChangeDirty` fires on each change of
the answer, and `updateDiskBaseline(uri, text)` records a write your own code
made; a save your code announces through `notifyDidSaveTextDocument` with its
text moves the baseline too.

Over the data head, every transfer document the head sends that it holds
carries the current answer as `dirty`, and a watcher is sent
`onDocumentDirtyChanged({ uri, dirty })` on each change;
`DataEvents.onDidChangeDocumentDirty` fans it out. After a reconnect, a
`DataSession` reads each document it restores once its watch is in place, and
tells the connection's client the answer where it differs from the last one
the client was told since its open, so a flip while the connection was down
reaches it.

A diagram's dirty state is the same answer over every document the diagram's
session has open, read by `HydraniumGlspCommandStack`, and its storage sends
the client each change, so one the diagram did not make reaches it too. While
a save of the diagram's own is awaited, the storage sends nothing: GLSP's save
handler sends the state once the save is done, reason `save`, and GLSP's own
saveable waits for that answer. An editor keeps a dirty flag of its own, since
LSP has none to send it.

In Theia, bind `EditorDiskSync` from `@hydranium/client-theia/browser` as a
`FrontendApplicationContribution`. A server save of a document an editor shows
unsaved writes the editor's text, and Theia keeps the editor dirty; its next
save applies the editor's pending edits to that file a second time, since its
check that the file is unchanged passes when the size is. Before each save of
an editor, `EditorDiskSync` reads the file, and when it holds the text the
editor held as the save began, drops the edits pending then and has the save
expect the file's version. The save goes on and writes only what changed
after that point, such as a save participant's trim of trailing whitespace,
onto the file. Save All relies on that check: it saves a diagram and an editor
on the same file one after the other, faster than the file watcher reports
the diagram's write. A file that cannot be read within a second leaves the
save to Theia as it is. A watched change to the editor's text marks it clean
too, once any save of it in flight has finished.

Beside it, rebind Theia's `FileService` to `HydraniumFileService` from the same
entry. It refuses an editor's incremental save once the file's mtime is past
the one the editor read, whatever the size, and the editor then writes its
whole text, through Theia's own check. That covers the save `EditorDiskSync`
leaves alone because the file holds neither the editor's text nor the text it
read.

## Last close

When the last client with a document open closes it, the text store releases the
document and rebuilds it from the file system provider, or removes it, for every
head and for a server with no language server at all. The unsaved edits of its
last client are discarded with it. The revert is decided under the workspace
write lock, after the file's disk queue has drained, so a save issued before the
close is not reverted past; a client that opens or re-creates the file meanwhile
keeps its text, and no revert follows.

The bound `FileSystemProvider` decides by `exists`, for a URI of any scheme: a
document it can serve survives its last close, rebuilt from the provider's text,
as a model file of a workspace on the in-memory or persistent provider is,
whatever its scheme. Any other is removed from the workspace, such as an
editor's `untitled:` buffer or a `file:` document created and never saved. A
`virtual:` document, built under `virtualUri`, survives, since the framework's
providers serve it from the index; an edited one therefore keeps its edit after
the close, and keeping it read-only is the client's job. An adopter's own
provider has to answer `exists` and the reads for every scheme whose documents
should survive, `virtual:` included, for instance by extending a framework
provider or by consulting `serveVirtualDocument` in each of them. A change the
LSP head still has debounced for the document is dropped: the revert rebuilds or
removes the document, and the text a `virtual:` document is rebuilt from already
holds that change.

`TextDocuments.onDidCloseLastOpen` fires when a document is released, just
before its revert.

<!-- snippet-preamble
import { HydraniumTextDocuments, type ServerSharedServices } from '@hydranium/core';
-->

```ts
const sharedModule = {
   workspace: {
      TextDocuments: (shared: ServerSharedServices) => new HydraniumTextDocuments(shared, { revertGraceMs: 0 })
   }
};
```

`revertGraceMs` in `HydraniumTextDocumentsOptions` defers the revert of a
document whose last close came from a lost connection: a data connection that
closed, or a session a reconnecting client took over with its resume token.
The store keeps the document, and its unsaved text, for that long. A client
lost from the document may reclaim that text only within the grace of its own
loss: an open under its id in that time, such as a session a reconnecting
client registers again or takes over with its resume token, cancels the revert.
An open under any other id, a reloaded page's new session or an editor
attaching over the LSP head included, releases the document first and then
opens it as a first open does: a session reads the file, and an editor keeps
the text it opened with. So does an open under a lost id whose own grace has
run out, though a later loss keeps the document waiting: that client would
otherwise inherit unsaved text written after it was lost. A `create` of the URI
is refused while the document waits. It is open for no client meanwhile, and
`TextDocuments.isRevertPending(uri)` answers `true`; the integrity service
treats it as open, so none of its unsaved text reaches disk. A close the
client makes itself, `closeSession`, and a session's `dispose()` revert at
once, whatever the grace. The default is ten seconds; with `0` the revert
follows at once, and the document is released in the close itself rather than
on a timer.

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

`create(uri, text)` fails when a file exists at `uri`, when the URI waits out
the revert grace, or when any client, the session itself included, has the URI
open, including a client whose open lands while the create is under way: of
two creates of one URI, at most one succeeds. Otherwise it opens a document
holding `text` for the session. The document exists in memory only; it reaches
disk with the first `save`.

## Ending a session

`dispose()` closes every document the session has open, each through the
ordinary close, and frees the id, all before it returns. A second `dispose()`
does nothing. `dispose('lost')` ends the session as its connection going away
does, so each document it was the last to have open waits out the revert
grace. Every other member throws `SessionClosedError` from then on,
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
why no session can take that id. It is not a session: its opens come over the
LSP connection, and an LSP disconnect ends the server process. A head in a
worker outlives its connection, and a `MessagePort` itself reports no close:
the port transport's in-band close signal does, and on it the host calls
`TextDocuments.closeLanguageClientDocuments()`, which closes the language
client's documents as a `didClose` for each would. Langium binds one LSP
connection to a shared-services tree, and the language-client state the text
store keeps is keyed by URI alone, so a server process serves one LSP
connection.

The language client's close is not a lost one, so when a page disposes both
its data connection and its worker's language client, their order decides what
a document open in both keeps. If the data connection closes last, its sessions
end as lost, and the document keeps its unsaved text for the revert grace; if
the language client closes last, the document reverts at once. An editor's
`didClose` that closes a document last reverts it at once too.

## Known limits

- A browser tab that closes can await no save; `beforeunload` can only prompt.
- A write in flight when the backend process is killed is lost. The Node file
  system provider writes a staging file first, so after a crash disk holds the
  old file or the new one, except for a hard-linked file, which is written in
  place and can be torn. Nothing calls `fsync`, so a power loss is not covered.
- A worker `MessagePort` reports no end of its own. Over
  `createMessagePortTransport` a head learns of a client that disposes its
  connection, but a page or a worker that dies ends no session. A language
  server in a worker keeps running when its port's client goes, unlike one on
  stdio, which exits when its input ends; only the language client's documents
  are closed.
- An editor save whose wait runs past `willSaveGateMs`, or whose `didSave`
  comes later than that, can land before or after a server write of the same
  file. The cap that ran out is logged.
- VS Code stops sending `willSaveWaitUntil` for the session after four failed
  or timed-out answers; the editor's saves then no longer wait for the
  server's writes. The 1000 ms default stays under its timeout.
- A server write of a file queued before the editor's save always lands
  first, so the editor then saves over a file newer than its buffer, which VS
  Code reports as a newer file on disk and Theia as out of sync. The gate only
  makes that order certain: the conflict follows whenever the server's write
  lands first.
- A client that reconnects after the revert grace has run out finds its
  sole-client documents reverted: other sessions see the revert, and the
  reconnecting session reports its unsaved edits lost.
- The disk baseline moves only when the server reads or writes the file, or a
  watcher reports a change, so it trails a write by another process until the
  watcher's report; a server without an LSP head has no watcher. The integrity
  service reads the file before its repair write for that reason.
- Every first open by an editor takes its buffer as the file's text, so a
  buffer it never saved counts as clean. That includes a language-server
  restart: the language client opens each dirty buffer again, and the diagram
  and the data clients then show those documents clean while the editor shows
  them dirty.
- VS Code keeps an editor dirty when the file changes to the text it shows;
  its next save writes the same bytes. There is no VS Code counterpart of
  `EditorDiskSync`.
- `EditorDiskSync` takes the editor's text as the save calls its will-save
  listeners. Theia runs its save participants one after another, each behind
  an await, and its first one awaits before it edits, so none has changed the
  buffer by then. A participant ordered ahead of it that edits before its first
  await makes the save apply every pending edit again, unless
  `HydraniumFileService` is bound, which has the save write the whole text,
  or ask when the file's size changed.

## Logs

Log lines cut a client id eight characters after its last `#`, so a minted
session id prints as its label, the `#` and the first eight characters of the
UUID, which is enough to tell sessions apart; an id without `#` prints whole.
Starting and ending a session also log the full id at trace level.
