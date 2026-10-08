# GLSP operations

How a diagram operation edits the shared model, and why its handler follows the
rules in [Make a diagram editable](../../guides/editable-diagram.md).

## A working copy, written once

A handler mutates `sourceRoot` inside `HydraniumGlspRecordingCommand`; the
operation writes the copy's projection once when it completes, which persists
and republishes it to the other heads, and undo and redo apply that one change.
During an operation `sourceRoot` is a working copy of the built root, so no
other reader sees the edit before its write lands.

The root of any other document the handler edits is reached through
`modelState.workingRootOf(uri)`; a root read from the model service is the one
every reader shares.

## Nodes without a document

Nodes of a working copy have no `$document`, so a transfer encoder hook sees no
`context.uri` while it projects them, and a lookup that reads a node's document
— a scope, reference candidates, or the project a name is qualified in — throws
or answers for no document. `modelState.builtNodeOf(node)` answers the built
node for such lookups, while the handler keeps editing the copy.

## References into the copy

`modelState.referenceTo(target, source)` builds a reference whose `ref` stays
the copy node, which an identity comparison later in the same operation needs.
By default its `$refText` is the `ReferenceBuilder`'s answer for the built
target and the source's nearest built container, so a target renamed in the
same operation is named as built, and a target created in it is named without a
project. With `{ tier: 'own' }` it is the target's own name, read off the copy.
The builder called on a copy node directly loses the projects and the target's
language.

## What runs again on undo and redo

A side effect a command carries outside the model — a command that does not
record, or a recording command's `undoAction` / `redoAction` — runs again on
undo and redo, against throwaway copies: `sourceRoot` and `workingRootOf` answer
copies there, discarded afterwards, and the model changes only by the
operation's recorded transition. A recording command executed there throws; the
undo then fails whole: the steps it already ran are run back, nothing is
written, and GLSP's command stack flushes.

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
