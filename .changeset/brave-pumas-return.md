---
'@hydranium/protocol': minor
'@hydranium/data-server': patch
---

An open that fails after taking its server hold now releases it. `openDocument`
takes the hold and then starts the watch, and `openModelDocument` records the
hold and then builds the snapshot it answers with — so a failure in the second
step failed the call while the hold stood, with the caller seeing no open and
therefore issuing no close. Which call answers for that hold is decided by the
last open in flight for the URI rather than by the one that failed, a hold being
one per `(uri, clientId)` however many opens share it. A hold a disposed session
cannot release passes to `DataSessionHost.orphanHold`, new and optional, which
`DataConnection` retries on its own subsequent activity; `createSession` refuses
an id that still owes one, whose release would otherwise close the new
participant's document.
