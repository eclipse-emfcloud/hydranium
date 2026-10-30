# GLSP operations

How a diagram operation edits the shared model, and why its handler follows the
rules in [Make a diagram editable](../../guides/editable-diagram.md).

## An operation copy, written once

A handler mutates `sourceRoot` inside `HydraniumGlspRecordingCommand`; the
operation writes the copy's projection once when it completes, which persists
and republishes it to the other heads, and undo and redo apply that one change.
During an operation `sourceRoot` is an operation copy of the built root, so no
other reader sees the edit before its write lands. The operation opens before
the handler's `createCommand` runs, because handlers resolve their targets
there. A node of the source document that `createCommand` resolves by id or
from `sourceRoot` is therefore already the copy.

The root of any other document the handler edits is reached through
`modelState.operationRootOf(uri)`. A root read from the model service is the one
every reader shares. An id added through `indexSemanticElement` for a node of
that document names the built node until that call makes the copy.

## Nodes without a document

Nodes of an operation copy have no `$document`, so a transfer encoder hook sees
no `context.uri` while it projects them, and a lookup that reads a node's
document — a scope, or the project a name is qualified in — throws or answers
for no document. `modelState.builtNodeOf(node)` answers the built node for
such lookups, while the handler keeps editing the copy.

## References into the copy

`modelState.referenceTo(target, source)` builds a reference whose `ref` stays
the copy node, which an identity comparison later in the same operation needs.
Unless asked for the target's own name, its `$refText` is named against the
built target and the source's nearest built container: a target renamed in the
same operation is named as built, and a target created in it is named without
a project. The `ReferenceBuilder` called on a copy node directly loses the
projects and the target's language.

`modelState.referenceInfoOf(node, property)` asks a candidate query from the
built node in-process, and for a node the operation created, from a stand-in
of its type under the built containers it sits in. A scope reads local names
off every container up the chain, so a query anchored higher, at the document
or a named ancestor, misses them. The same construction serves a node not
created yet, inside an operation or outside one: a stand-in the caller builds
reaches its document through `$container` alone, so it need not be attached.
`modelState.referenceInfoAt(container, path, property)` builds that stand-in
chain from `SyntheticStep`s, as a protocol context's `syntheticPath` is built.

## What runs again on undo and redo

A side effect a command carries outside the model — a command that does not
record, or a recording command's `undoAction` / `redoAction` — runs again on
undo and redo, against throwaway copies: `sourceRoot` and `operationRootOf`
answer copies there, discarded afterwards, and the model changes only by the
operation's recorded transition. A recording command executed there throws; the
undo then fails whole: the steps it already ran are run back, nothing is
written, and GLSP's command stack flushes.

A side effect can bring the document to the undo's or redo's result before the
write, as an integrity rule repairing the document on build does. The write's
reconcile then finds every changed path already holding its value, writes
nothing, and the undo or redo succeeds on the document's built root. An array
counts as held only whole, since a patch addresses its elements by index, and
an inserted element never does, since two equal insertions may both be meant.

## A dropped edit is told to the client

Every diagram action that does not take effect sends the client a message;
otherwise the diagram returning to the document's state, or an undo doing
nothing, reads as a fault. A write the reconcile drops is told as a dropped
edit, whether an operation or a recording command executed outside one wrote
it. An undo or redo that a foreign edit of the same field skips, wholly or in
part, is told as skipped.

An undo or redo that fails clears the undo and redo history, as GLSP does, and
its message says so. A write dropped or conflicting while it runs is told as a
foreign edit; any other failure as an error.

A recording command executed outside an operation whose write is dropped pushes
no undo step. In a compound whose other commands wrote, the step is pushed
without it, and the server logs a warning.

## One gesture, one operation

An operation a handler dispatches runs after the handler's own, as its own
write and undo step, and its `dispatch` resolves before it runs. A gesture of
several edits is therefore a `CompoundOperation`, or a handler that executes
another operation's handler through the `OperationHandlerRegistry` inside
`createCommand`. Only operations are queued that way, and only while one runs,
its undo's side effects included. Other code that runs while the diagram holds
its order — a GModel factory, a submit, an undo's write — must not dispatch an
operation and await it, and no such code may await a dispatched undo, redo or
model request: each waits for that code to finish, and the two deadlock.

## Edits the server has not answered yet

A client that counts its edits in flight, as a browser page's mount does, sends
a `RequestEditsSettledAction` after each operation, undo or redo, and counts the
edit until that request or a later one is answered or rejected: the server
handles a client's actions in order, so a later answer covers an edit whose own
request was lost. The server answers with `EditsSettledAction` only once the
edits sent before the request have been handled, a queued operation's run in the
state's exclusive section included; what such an operation answered has been
delivered, its dirty state among it; and the language client has answered the
push of each document a save writes. The last two waits are bounded, by the
handler's `settleDeliveriesMs` and `settleLanguageClient`'s own bound, and past
a bound the server answers anyway; a delivery given up on is not waited for
again. The handler returns at once and dispatches its answer once the waits are
over, so the diagram's later actions do not wait for them, and a delivery the
browser worker's dispatch scope queues behind the request still runs before the
answer. An operation that a handler of a delivered action dispatches without
awaiting is not waited for, nor, in the browser worker, one that a queued
operation dispatches. In the browser worker a queued operation's delivery can
run in GLSP's own queue, so one that hangs holds the request behind it, as any
hung handler holds what follows, and `settleDeliveriesMs` never starts. The
client's own wait, `settleEditsMs`, sits well above both server bounds together,
so a page refuses a save only on a server that has stopped answering or whose
handling of the edits before took longer still. A client asks only a server that
advertised the request, since one that never answers would keep the count up for
good. A request that carries a timeout, as GLSP's `requestUntil` sets, is
rejected once it passes, as any request is, and the answer that follows is
dropped; the dispatcher sends it with `request` and bounds the wait itself.
