---
paths:
  - "packages/*/test/**"
  - "examples/*/*/test/**"
---

# Test files

Instrument a test with `process.stderr.write`, not `console.*`. Vitest prints
a test's console output only when that test fails, under whichever test was
running when the line was written, so a line from a passing test never shows
and a late one lands under the wrong test. Stderr prints whether the test
passes or fails, though a line written after the file's last test has ended
is lost either way.

A type-level guarantee goes in a `*.types.test.ts` file: each refusal is a
`@ts-expect-error`, which `typecheck:test` fails when it goes unused, and each
acceptance compiles without one. Vitest only transpiles, so `typecheck:test`
is what runs these, and a constraint that stops holding reddens that file and
nothing else. A runtime test cannot see a type that admits too much; it only
passes values the type already accepts
([test support](../../docs/contributing/conventions.md#test-support)).
