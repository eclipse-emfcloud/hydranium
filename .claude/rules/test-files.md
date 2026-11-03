---
paths:
  - "packages/*/test/**"
  - "examples/*/*/test/**"
---

# Test files

<!-- guidance-claim: vitest-console-output test=scripts/guidance-console.test.mts -->

With the shared configuration, Vitest prints console output from passing
and failing tests. A command that sets `--silent` can suppress it. Use
`process.stderr.write` when a diagnostic must bypass console capture, and
write it while the test is still running. Do not infer which asynchronous
operation produced a line from the test name the runner prints above it.

A type-level guarantee goes in a `*.types.test.ts` file: each refusal is a
`@ts-expect-error`, which `typecheck:test` fails when it goes unused, and each
acceptance compiles without one. Vitest only transpiles, so `typecheck:test`
is what runs these, and a constraint that stops holding reddens that file and
nothing else. A runtime test cannot see a type that admits too much; it only
passes values the type already accepts
([test support](../../docs/contributing/conventions.md#test-support)).
