---
'@hydranium/core': minor
---

An integrity repair of a URI open in the text store is committed into the store's
own document rather than into whichever text-document object the build happens to
hold. The two are the same on the LSP path and are not when the document was
built for an already-open URI through `LangiumDocumentFactory.fromString`, so a
repair corrected a copy the store did not know about and the reconciling re-parse
then discarded it — the AST showed the repair, the editor and the outbound edit
did not. Freshness is judged against the CST's own `fullText`, the text that
produced the AST, since the carried text document IS the store's object on the
LSP path and comparing it against the store could only ever agree. A repair whose
source text the store has already replaced is abandoned rather than persisted,
and the document is reconciled so no settled consumer reads an AST built from
text nobody has. `HydraniumTextDocuments.commitRepair` and its `RepairCommit`
result are new.
