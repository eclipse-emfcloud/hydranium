---
'@hydranium/core': minor
---

`DefaultFileSystemProvider.writeFile` refuses a URI that names no location on
disk instead of deriving an OS path from it. `URI.fsPath` yields a path for any
scheme, so a `memory:`, `untitled:` or `https:` write did not fail — it created a
real file, and the directories above it, somewhere unrelated. `mtimeMs` answers
`undefined` for such a URI rather than the modification time of whatever occupies
its `fsPath`, which the self-save registry keys on to suppress watcher echoes.
The rejection carries the new `UNSUPPORTED_WRITE` code, deliberately distinct
from the not-found codes, which invite a caller to create what is missing. An
integrity repair of a virtual document is kept in memory rather than written,
that document having no disk backing to write to.
