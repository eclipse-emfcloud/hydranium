---
'@hydranium/core': patch
---

`ModelService.update` decides the optimistic based-on gate before serializing
and opening, so a write it refuses leaves nothing behind. `update` is an upsert,
and the open it performs installs the payload in the shared text store and
records a hold for the writing client — so rejecting afterwards handed the
caller its `ConflictError` while the server kept the refused text, and the hold
outlived the call, a client whose write failed having no reason to close a
document it never asked to open. The version is still read before that open,
which a document no client holds open depends on: the open assigns the shared
version from the incoming text, so a version read afterwards has already
absorbed the caller's own write.
