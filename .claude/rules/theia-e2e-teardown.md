---
paths:
  - "examples/order-flow/theia-app/**"
  - "packages/core/src/testing/playwright/**"
  - "packages/core/src/node/startup-cpu-profile.ts"
---

# The Theia e2e teardown

Playwright ends this tier's `webServer` with a SIGKILL to its process group:
the shell, npm, `start.mts` and the Theia CLI. The backend is not in it,
because the CLI starts it detached. It exits once its poll finds the CLI
gone, and its `exit` handler sends SIGTERM to every descendant and then to
its group, so a language server receives two SIGTERMs in quick succession.

Teardown work in a language server runs from an `on` listener kept until the
work is done, and is synchronous. A `once` listener is removed before its
body runs, so the second SIGTERM takes the default action and ends the
process mid-write; `startup-cpu-profile.ts` is the worked case.

Nothing orders that work against a reporter's `onEnd`. Playwright runs it
once the backend's pipes close, and a language server holds none of them, so
a reporter reads what servers wrote at teardown on a best-effort basis
([the e2e suite](../../examples/order-flow/theia-app/README.md#the-e2e-suite)).
