---
'@hydranium/core': minor
---

Claim every sentence Langium and chevrotain put on a document, so an adopter
catalogue can translate a syntax error.

Seven diagnostics now carry a framework message identity with the parameters a
translation interpolates: `unexpected-character`, `unpoppable-lexer-mode` and
`invalid-dedent` from the lexer, `unexpected-token`, `trailing-input`,
`no-viable-alternative` and `missing-iteration` from the parser. The English is
unchanged, so a consumer shipping no catalogue sees exactly what it saw before.

Two codes are renamed, which is breaking for a catalogue that keys on them:

- `hydranium/core/lexing-error` is now `hydranium/core/unexpected-character`
- `hydranium/core/redundant-input` is now `hydranium/core/trailing-input`

`Diagnostic.code` and `TransferDiagnostic.code` now carry the framework code on
a parse error where they previously carried `undefined` and `'parsing-error'`
respectively. Langium's `data.code` is preserved, so a consumer switching on
`'parsing-error'` there — or on `TransferDiagnostic.type` — is unaffected.
