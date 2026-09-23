---
'@hydranium/core': minor
---

A write that re-serializes a document from its AST now carries the author's
comments and the whitespace the file ended with, through a `trivia` slot group
whose preservers run around the serializer. That covers an integrity repair of
a closed document, a diagram operation and a form editor's transfer write, none
of which previously kept either. A comment is anchored to the AST node it hangs
off, located again by re-parsing the serializer's output, and dropped rather
than moved when the write leaves its identity ambiguous.

`AbstractSerializer.trimSerialized` and the `trimTrailingWhitespace` option are
removed: trimming was formatting policy inside a serializer, and the document's
own ending is now restored by `DocumentEndingPreserver`. A grammar whose
content can end in whitespace overrides that preserver's `apply`.
