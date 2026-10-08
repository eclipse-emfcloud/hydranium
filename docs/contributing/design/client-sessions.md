# Client sessions

The full contract of a client session, head by head. The adopter's view is in
[How it works](../../concepts/how-it-works.md#documents-sessions-and-saves) and
[Connect a data client](../../guides/connect-a-data-client.md); how the store
and the manager underneath share one document is in
[Model coordination](model-coordination.md).

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

An id is unique in the process while its session is live. `createSession`
refuses, with `DuplicateClientIdError`, an id another live session holds or one
a client that is not a session has documents open under, and refuses, with
`ReservedClientIdError`, the ids in `RESERVED_CLIENT_IDS`, which the framework
keeps for its own participants. Opens are keyed by id, so two holders of one id
would share their opens, and either one's close would close the other's
documents. An ended session's id is free again; a reserved id never is. The one
way to take a live id is its resume token (see
[Over the data head](#over-the-data-head)).

Every disk write a session makes goes through `DefaultClientSession`'s
protected `persistDocument`: a `save`, a `persist`, and a diagram's save,
whichever head asked; an editor's own save and an integrity repair written
straight to disk do not. An override that awaits before calling the base lets a
diagram save take its documents' texts at different moments, and a diagram
that ends during the await fails the documents not yet taken with
`DocumentNotOpenError`. An override that writes the text elsewhere instead of
calling the base announces the save itself, through
`TextDocuments.notifyDidSaveTextDocument` with the text it wrote: the disk
baseline, and with it the dirty state, follows that announcement.

## Open and close

A session has a URI open once, without reference counting: a repeat open
changes nothing and keeps the first open's options, and one `close` ends it, so
two participants that each need a document open use two sessions.

## Writes need an open

`update`, `save` and `persist` never open a document. Each fails with
`DocumentNotOpenError` unless the session has the URI open in the synchronous
step that applies or takes the text, and the `baseVersion` gate, which fails
with `ConflictError`, runs in that same step. A check an await separates from
the apply lets a write land on a document the session closed meanwhile, and
two writes based on one version both apply. So a write either lands while the
document is open or fails, and a document is never reopened behind a write.

A write answers with the document once it is validated, in whichever build
carried it: its update event names the writer, so a client that drops its own
echo gets the diagnostics only from the answer. The first event for a version
is `changed` and names its author; a later one is `rebuilt` and names
`UNKNOWN_CLIENT_ID`, since a rebuild caused by a referenced document is news to
every client. `AstDocumentManager.attributeUpdate` decides this for every head,
and `TransferDocumentUpdateReason` names the cases that fall back.

There is one shared text per document. A save writes the session's model and
then persists the shared text, other participants' unsaved edits included; a
persist writes that text as it is, so their formatting survives. Once the text
is taken, the write completes even if the session closes the document or ends.
Writes land between a save's build and its take, so a client that marks a
version saved takes `persisted.version`, not the answered model's. The data
head's persist request waits for the build after the write, so it can fail
with the text already on disk.

## `updateAll`

`updateAll` is all or none: every model is serialised first, then every open
check and gate runs and every text applies in one synchronous step. That relies
on `AstDocumentManager.update` applying its text before its first await; an
override that awaits first lets another write land inside the set.

## Over the data head

A data-server connection registers sessions with `createSession`, refused for a
reserved id and for one live anywhere in the server process. The exception is
`resumeToken`: a registration carrying the token an earlier registration of the
same id carried ends that session, as its connection closing would, and
registers the id afresh, so a client whose connection dropped can register
again before the server has noticed the drop. The token guards against
colliding with that session; it is not a secret, since the wire carries no
authentication, and a takeover ends the old session even when its connection
is still alive. `ModelService.createSession` takes the same token in process.

The session belongs to the connection. Every document request acts as the
session its client id names, and an id not registered on that connection fails
with the `SessionClosedError` code rather than opening anything, so a head that
serves the data protocol implements sessions. Watching needs no session.
`closeSession` ends a session as closed; the connection closing, or a takeover,
ends it as lost, which lets each document it was the last to hold wait out the
release grace (see [Last close and release](#last-close-and-release)).

## `DataSession`

`DataSession` is the client side of such a session. `closeDocument` and
`dispose` first wait for its calls in flight, up to `settleBeforeCloseMs`, so a
save sent just before a close reaches the server first; a client without it
that closes without awaiting its save gets the `DocumentNotOpenError` code.
A participant that only follows a document uses `connection.watchDocument`,
since an open would hold the document for as long as it follows.

After a reconnect the connection registers each session again under its id and
resume token, and the session re-opens, re-watches, and puts back what it wrote
since each document's last save. It decides by text, not version: a revert
moves the version on and a restarted server numbers versions afresh, so a
version never tells whether the server still holds a write. Every document the
data head sends that it holds carries a `text.hash` of the text alone. For each
document written since its last save, the session keeps the hash its first
unsaved write was based on, and its last write with that write's answer. After
the re-open:

- A document that holds the last write needs nothing.
- A document back at the text the first unsaved write was based on, reverted
  after the grace or by a restart, gets the last write again, based on the
  re-opened version. It is an ordinary write, so an edit that lands between
  the re-open and the write makes it conflict.
- Any other document was changed by another client, and nothing is written.

Documents last written by one `updateDocuments` are written again by one, and
only when every one of them can be. No caller waits on a restore, so it reports
rather than throws or retries. What cannot be put back, a conflicting write
included, is reported once through the connection's error sink
(`DATA_SESSION_UNSAVED_LOST`) and forgotten, since a retry would overwrite
another client's edit. A document that cannot be re-opened is reported with
`DATA_SESSION_RESTORE_FAILED` and forgotten, and nothing of its set is written
again; a write that fails for another reason is reported the same way but kept,
so the next restore decides again. A write based on `'any'` has no base, so it
is reported rather than written again. The session drops a document's record
on its own save, a close, the document turning clean, and another client
writing over it while the connection holds, so the report covers only what the
drop cost.

### In Theia

`bindDataConnection` has `DataSessionStopContribution` dispose every session
when the page stops, so the server ends them as closed and releases their
documents at once, rather than ending them as lost when Theia finally drops the
connection. A session with a call in flight at the stop closes too late, and
the page's last frames can be lost under load, so the close is best effort.
The adopter's side is in
[Connect a data client](../../guides/connect-a-data-client.md#in-theia).

## Over the GLSP head

Each GLSP client session is one client session. `HydraniumGlspStorage`
registers the GLSP client id as its id when the diagram loads and hands the
session to the diagram's state as `modelSession`; GLSP's placeholder client,
`TEMPORARY_CLIENT_ID`, registers nothing. The diagram opens its source document
and each document of its write set through the session, and ending the storage
ends the session, which closes everything it has open. A document that leaves
the write set stays open until the next save, which saves and then closes it,
so leaving never reverts the diagram's unsaved edits to it.

Hydranium's Theia diagram manager keeps a diagram's client id across a reload
and a reconnect of its window, and the load carries the window's resume token
(`RESUME_TOKEN_ARG`), so a reloaded diagram takes the old session over, ending
it as lost, and reopens on its unsaved text. The window claims its id and token
as its frontend starts and hands them on only as it leaves, so a duplicated tab
resumes nothing of the original's. The adopter's side is in
[Host in Theia](../../guides/host-in-theia.md#unsaved-diagrams-and-reloads).

A load without a token whose id is held waits up to `sessionWaitMs` for the
holder to end; a load whose token does not match is not kept waiting. When the
id is still held, the diagram does not load (`DIAGRAM_SESSION_REFUSED`). Taking
the id without the token would end another participant's session, and working
beside it would share its opens, so its close would close the diagram's
documents too.

`ReconcilingMultiDocumentGlspState` writes the changed documents of the write
set in one `updateAll`, so a conflict on any of them leaves every one as it
was, and the conflict resolver handles the set as a whole; a conflict whose
refetch is unavailable fails rather than forcing the write. Session writes open
nothing, so the state opens each document through `openForWrite` first, and
every state refuses to write without a session.

A diagram save persists every document the session has open at `'any'`, since
the store already holds every client's writes; a document only another client
has open is not saved. Each save takes its texts in one step, which an
awaiting `persistDocument` override breaks (see
[Starting a session](#starting-a-session)).

## Disk writes

Every disk access of a file the framework makes on the server goes through one
queue per file, `FileSystemTaskQueue`, whichever session, head or service makes
it. Each save takes its text when it is called and writes in the order it was
called, so the file ends with the newest saved text; two writes that bypass the
queue can land in either order. Files do not wait for one another, and updates
do not wait for the queue. A build waits only for its own repair write, which
queues behind earlier saves of that file.

Code that writes a file the framework also saves runs its write through
`FileSystemTaskQueue.enqueue`. The task must not await a build, a save,
another queued task, or an open of a document no client has open, for the same
file: what it waits for queues behind it, and the file's queue stops for good.

With `coalesceSaves`, a save still waiting behind another is skipped when a
newer save of the same file queues behind it; it announces nothing and takes
the newer save's outcome.

## Editor saves

An editor behind the LSP head writes the file itself, and the server joins
that save to the file's disk queue: the answer to `willSaveWaitUntil` waits for
the server's writes already queued, so the editor writes after them, and server
writes queued after the editor's save wait for its `didSave`, so they land
after the editor's write. `willSaveGateMs` caps each wait, and the answer never
fails, since VS Code stops asking for the rest of the session after repeated
timed-out or failed answers.

On `didSave` the store reads the file back through its disk queue and fires
`onDidSave` under `language-client` only when the file holds the document's
current text. The editor saves its own buffer, which lags the store while
another client's edit is on its way to it; the file, not the editor, tells
whether the shared document is on disk.

## Dirty state

`TextDocuments.isDirty(uri)` answers whether a document's text differs from its
disk baseline, the text the server last knew the file to hold. The baseline
moves only where the server reads or writes the file: a first open, a server
save, an editor save (the file as read back), a watched-file change the server
did not write, and an integrity repair written to a file some client holds. A
document from `create`, or opened on content the integrity service staged, is
therefore dirty from the start. Code that writes a file itself records it with
`setDiskBaseline`, or announces the save through `notifyDidSaveTextDocument`.

A released document is not dirty. A dirty one announces the change once the
`DocumentReleaseHandler`'s promise settles, so the announcement carries the
text the build then holds, or none when the build removed the document, failed,
or was skipped because the connection or the workspace went away.

Over the data head, a flip for an edit is sent to watchers when the text
changes, before the build that follows, so its `text.version` can be ahead of
the `model.version` a client holds; see
[Comparing the two versions](../../concepts/document-layers.md#comparing-the-two-versions).
After a reconnect, a `DataSession` reads each restored document once its watch
is in place and any write is sent again, so a flip while the connection was
down reaches its client and a document written again does not flash clean
first. A diagram's dirty state is the same answer over every document its
session has open. An editor keeps a dirty flag of its own, since LSP has none
to send it.

`EditorDiskSync` exists because a server save breaks Theia's incremental save.
A server save of a document an editor shows unsaved writes the editor's text,
and Theia keeps the editor dirty; its next save applies the pending edits to
that file a second time, since its check that the file is unchanged passes
when the size is. Before each editor save, `EditorDiskSync` reads the file and,
when it holds the editor's text, drops the pending edits, so the save writes
only what changed after. `HydraniumFileService` covers the save it leaves
alone, where the file holds neither the editor's text nor the text it read: it
refuses an incremental save once the file's mtime is past the one the editor
read, and the editor writes its whole text. `bindEditorDiskSync` binds both.

## Last close and release

A close belongs to one client: it ends that client's open of the document, and
another client's open is untouched. A release belongs to the text store: it
drops the shared text it has owned since the first open, once no client holds
the document. The two coincide at the last close, unless that close came from
a lost connection: a data connection that closed, a GLSP connection that closed
under a diagram, or a session a reconnecting client took over with its resume
token. Then the release waits out `releaseGraceMs`, and meanwhile the document
is open for no client and `TextDocuments.isReleaseDeferred(uri)` answers
`true`.

Only the lost client may reclaim the text, and only within the grace of its own
loss: an open under its id in that time cancels the release. An open under any
other id, a reloaded page's new session or an editor attaching over the LSP
head included, releases the document first and then opens it as a first open
does; so does an open under a lost id whose own grace has run out. Otherwise a
client would inherit unsaved text written after it was lost. A `create` of the
URI is refused while the document waits, and the integrity service treats it
as open, so none of its unsaved text reaches disk. A close the client makes
itself, `closeSession`, and a session's `dispose()` release at once, whatever
the grace.

At the release the store drops the document's text, keeping only its version
sequence, and fires `onDidReleaseDocument` before it hands the document to the
`DocumentReleaseHandler`, so listeners act before any build the handler runs.
The default handler rebuilds the document from the file-system provider, or
removes it, discarding its last client's unsaved edits. It reads the file once
the file's disk queue has drained, so a save issued before the close is not
reverted past, and reverts under the workspace write lock, which checks again
that no client holds the document. The provider's `exists` decides, for any
scheme: an `untitled:` buffer or a `file:` document never saved is removed,
while a `virtual:` document, served from the index, survives with its edits,
so keeping it read-only is the client's job. How the provider dispatches by
scheme is in [Service placement](service-placement.md).

## Deletion

When a build reports a file deleted, every open of that file closes, except the
editor's: an editor keeps the buffer of a deleted file and goes on sending
changes for it. A session that writes the file afterwards gets
`DocumentNotOpenError`.

A subclass calling `TextDocuments.delete(uri)` closes every open of the URI, the
editor's included, before the document is removed.

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
end as lost, and the document keeps its unsaved text for the release grace; if
the language client closes last, the document reverts at once. An editor's
`didClose` that closes a document last reverts it at once too.

## Known limits

The limits an adopter meets are in
[Status and limitations](../../adopting/status.md#unsaved-edits-are-kept-only-so-far).
These concern the editor-save gate and the disk baseline:

- A server write of a file queued before the editor's save always lands
  first, so the editor then saves over a file newer than its buffer, which VS
  Code reports as a newer file on disk and Theia as out of sync. The gate only
  makes that order certain: the conflict follows whenever the server's write
  lands first.
- The disk baseline moves only when the server reads or writes the file, or a
  watcher reports a change, so it trails a write by another process until the
  watcher's report; a server without an LSP head has no watcher. The integrity
  service reads the file before its repair write for that reason.
- `EditorDiskSync` takes the editor's text as the save calls its will-save
  listeners. Theia runs its save participants one after another, each behind
  an await, and its first one awaits before it edits, so none has changed the
  buffer by then. A participant ordered ahead of it that edits before its first
  await makes the save apply every pending edit again, unless
  `HydraniumFileService` is bound, as `bindEditorDiskSync` does, which has the
  save write the whole text, or ask when the file's size changed.
