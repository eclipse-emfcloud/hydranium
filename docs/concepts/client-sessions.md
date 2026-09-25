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

`ModelService.update` and `ModelService.save` called with a client id that is
not a live session keep their older behaviour. They open the document for that
id first, and create it from the payload when no file exists; nothing closes
that open until the caller does.

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
