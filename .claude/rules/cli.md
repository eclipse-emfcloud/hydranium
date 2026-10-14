---
paths:
  - "packages/cli/**"
---

# The CLI

`hydranium-cli` is head-neutral: every command works on any language built on
the framework, and reaches a head only through the module its `--services` or
`--server` flag names. A command or a codegen step that knows one language's
types belongs in that language's build, not here
([commands](../../packages/cli/README.md#commands)).

A harness subcommand drives a function in `@hydranium/core/node` and does not
implement one here. `loadHeadlessContext` resolves `@hydranium/core/node` from
the head's dependencies, not the CLI's, so the function runs against the same
copy of core as the head's `createServices`. A CLI installed globally carries
its own copy, which need not be the version the head was built against; code
placed in this package would run on that one.
