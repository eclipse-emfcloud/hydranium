# Testing

How Hydranium is tested, how to run the tests, and how to add new ones.

This is the practical guide. The factory and harness conventions live in the
**Test support** section of [`conventions.md`](conventions.md).

## Strategy

We think in **layers**. Each layer answers a different question; a feature is
well-tested when the layers that apply to it are covered — not when one layer is
exhaustive.

| Layer | What it proves | Where it lives |
|---|---|---|
| **L0 — Static** | It type-checks. | `tsc -b` (src) + `typecheck:test` (tests) |
| **L1 — Unit** | One class/function behaves, collaborators stubbed. | each package's `test/`, run by Vitest |
| **L2 — In-process integration** | Several real collaborators wired through a seam (a server over an in-memory connection). | `makeLspHarness` (`@hydranium/core/testing/node`), `makeDataServerHarness` (`@hydranium/data-server/testing`), `makeGlspHarness` (`@hydranium/glsp-server/testing`), exercised from the example server |
| **L3 — Conformance** | An implementation honors a protocol, host-independent. | `@hydranium/conformance` (per-head batteries) |
| **L4 — Subprocess** | A real server process over its real transport. | `startSpawnedServer` (`@hydranium/core/testing/node`) owns the spawn, the handshake, the captures, the port poll and the teardown; the specs live beside the entry they run — `examples/order-flow/server/test/smoke/` (stdio LSP, plus data and GLSP sockets) |
| **L5 — System / E2E** | The whole app through the real UI. | one Playwright suite per host the framework claims to run in — the Theia app and the browser page — each beside its own `playwright.config.mts`, adopter-style |

Cross-cutting techniques layered on top:

- **Golden corpus** — byte-stable `serialize(parse(x)) === x` over canonical
  fixtures (`examples/order-flow/server/test/fixtures/serializer/`).
- **Property tests** — `fast-check` over the patch/merge algebra
  (`packages/protocol/test/*.property.test.ts`).
- **Perf baselines** — `vitest bench` over a real example's services (not a gate).
- **Mutation audit** — Stryker, run on demand to find unasserted behaviour
  (not a gate; configured in `packages/core/stryker.conf.json`).

### Test-support conventions (one screenful)

- **Runner: Vitest.** Globals come from `'vitest'` (`import { describe, it, expect } from 'vitest'`), spies are `vi.*`, and a spy handle is typed `MockInstance`. No test SUITE imports `@jest/globals` — the one place it appears is the conformance kit's shipped jest runner adapter, which exists so an adopter on Jest can run the kit.
- **`typecheck:test` is the type gate.** Vitest only transpiles, so each package's `test` script runs `typecheck:test` before `vitest run`. Tests are type-checked by `tsc --noEmit -p tsconfig.test.json`, not by the runner. No package passes `--passWithNoTests`, deliberately: it turns "the runner matched no files" into exit 0, which no gate can tell from a suite that passed, so a config or glob change that stops matching would read as green forever. A package that genuinely has no tests yet should not carry a `test` script at all. `@hydranium/conformance` appends a second runner after vitest, a Jest pass under `--experimental-vm-modules` scoped to `test/jest/` (see `packages/conformance/jest.config.cjs`) that keeps the shipped Jest adapter from rotting. Read a package's own `scripts.test` before assuming the shape — the examples do not all match the framework's.

- **`testTimeout` is 20s under `CI` and 5s locally**, set once in `vitest.shared.ts`. The asymmetry is deliberate: a shared CI executor runs the same suite several times slower than a developer machine under equal parallel load, and a slow test is cheapest to find where it is being written. **It does not protect a SYNCHRONOUS test.** The timeout is an event-loop timer, so a test body that blocks — anything built on `spawnSync` or `execFileSync` — runs to completion however long it takes, and no timeout of any value will interrupt it. Make a test async if you want the timeout to mean anything for it.

- **Under `CI`, vitest also writes `test-results/junit.xml` per package**, uploaded by the workflow on `always()`. Its per-`testcase` `time` attribute is the only place a single test's cost is recorded: the console reporter totals a package and names no test, so without it "which test is closest to the timeout" can only be answered by one going red.
- **One construction verb — `make`.** Doubles are `makeStub<Service>()`, harnesses `make<Subject>Harness()`, builders/fixtures `make<Thing>()`. The one exception is `startSpawnedServer`, which owns a child process, so it takes the `start` verb the production launchers use and can fail rather than merely construct. Reusable scaffolding ships from a package's `*/testing` subpath (`@hydranium/core/testing`, …); most are browser-neutral and gated as such, and a few are deliberately excluded from that gate on their merits — `scripts/check-neutral-bundles.mjs` names each exclusion beside its reason, and being named there is what separates a considered exclusion from an oversight. Anything needing a real filesystem or a Node stream transport ships from `*/testing/node` instead.
- **No fixed sleeps.** Await asynchrony with `waitFor` / `tick`, never a hand-rolled `setTimeout`.

Full detail: **Test support** in [`conventions.md`](conventions.md).

## Commands

### The gate (run this before a PR)

```bash
npm run check        # the whole gate: see below
```

Individual stages, all run across every package via turbo:

```bash
npm test             # typecheck:test + vitest run
npm run lint         # eslint
npm run typecheck    # typecheck:test only
npm run build        # tsc -b (framework graph)
npm run build:all    # framework + the example apps
```

### One package / one file (fast inner loop)

```bash
npm test -w @hydranium/core                                   # one package
npm exec -w @hydranium/core -- vitest run test/util/uri-util.test.ts   # one file
npm exec -w @hydranium/core -- vitest run test/... -t 'partial name'   # one test
npm exec -w @hydranium/core -- vitest                          # watch mode
```

### UI / end-to-end (L5, Playwright)

There are **two** L5 suites, each with its own `playwright.config.mts` and its
own `test:e2e*` scripts — one per host the framework is expected to run in.
Neither is wired to `test`, so `npm run check` never depends on a downloaded
browser binary; each package's `//test:e2e` note states what only that tier can
cover. Locate them with `git ls-files | grep playwright.config`, which is the
enumeration that cannot fall behind.

**Theia host** — boots Theia on **localhost:3001** and drives it with a real
browser. Needs the app built first, and Chromium installed once.

```bash
npm run build:all                                              # bundle the app (incl. core)
npm --prefix examples/order-flow/theia-app run test:e2e:install   # one-time: Chromium
npm --prefix examples/order-flow/theia-app run test:e2e           # headless
npm --prefix examples/order-flow/theia-app run test:e2e:headed    # watch it run
npm --prefix examples/order-flow/theia-app run test:e2e:ui        # Playwright UI mode
npm --prefix examples/order-flow/theia-app run test:e2e:restart   # the @restart tier
```

`test:e2e` and `test:e2e:headed` carry `--grep-invert @restart`, so a run of
either **skips every `@restart`-tagged spec** — a contributor running only the
first two commands never executes them at all. Why, and the other traps this
tier has sprung, are in
[`examples/order-flow/theia-app/README.md`](../../examples/order-flow/theia-app/README.md),
which owns the Playwright config.

**Browser host** — the same head in a web worker, served as a plain page. Same
four verbs, no restart tier:

```bash
npm --prefix examples/order-flow/browser run build
npm --prefix examples/order-flow/browser run test:e2e:install   # one-time: Chromium
npm --prefix examples/order-flow/browser run test:e2e
```

Two caveats govern both Playwright tiers and have each cost time more than once:
`reuseExistingServer` is on outside CI, so a stray process on the port gets
tested instead of yours and a suspiciously fast pass is the tell; and the
webServer boots the **built** bundle, so framework changes need
`npm run build:all` first or you test stale code. Both are stated in full, with
the rest of the tier's traps, in
[`examples/order-flow/theia-app/README.md`](../../examples/order-flow/theia-app/README.md).

### Subprocess LSP smoke (L4)

```bash
npm test -w @hydranium/example-order-flow-server   # includes test/smoke/ (stdio LSP)
```

### Audits — on demand, NOT CI gates

```bash
npm run audit:mutation -w @hydranium/core         # Stryker, full core (~3 min)
npm run audit:mutation:quick -w @hydranium/core   # Stryker, model-service only (~10 s sanity)
npm run bench -w @hydranium/example-order-flow-server   # vitest bench, perf baselines
```

These are deliberately kept out of `turbo` / `npm test` / `npm run check`. Run
them when you want a coverage map (mutation) or a perf number (bench), not on
every change.

## What to do when adding tests

1. **Pick the layer.** A pure function or one class with stubbed collaborators →
   L1 unit in that package's `test/`. Something that needs a real grammar, the
   wire, or several services cooperating → an L2 harness test in the example
   server (core has no grammar, so grammar-dependent behaviour cannot be
   unit-tested in core). A protocol guarantee every head must honor → an L3 `@hydranium/conformance`
   check.
2. **Reuse the support kit.** Reach for `makeTestServices`, the `makeStub*`
   doubles, and the `make*Harness` factories before hand-rolling a mock. Add new
   scaffolding to the relevant `*/testing` subpath following the `make`-verb
   convention — or `*/testing/node` when it needs a filesystem or a Node
   transport, since `*/testing` is gated browser-neutral.

   Four of these are easy to miss because the thing they replace does not look
   like a mock:

   - **`makeParseSemanticRoot(services, guard)`** (`@hydranium/core/testing`) —
     parse text INTO the workspace and get the typed semantic root back.
     Langium's `parseHelper` registers the document but does not put it on the
     filesystem, and project discovery, `DocumentBuilder.update` and
     `getOrCreateDocument` all read from there, so a parse-only fixture breaks
     the moment anything rebuilds.
   - **`runUpdatePipeline(shared, args)`** (`@hydranium/core/testing`) — drive
     the rewrite chain plus the serializer the way `ModelService.update` does,
     with both resolved per URI. Hand-chaining the rewrites instead snapshots
     the registry, and a chain that has fallen behind still compiles and passes.
   - **`makeFakeDataPort` / `makeCapturingDataClient`**
     (`@hydranium/protocol/testing`) — the CLIENT side of the data head, usable
     without standing up a server.
   - **`makeGeneratedWorkspace({ root, generator, emit })`**
     (`@hydranium/core/testing/node`) — the scaffolding a deterministic volume
     corpus needs (seeded stream, marker-as-overwrite-permit, LF normalisation,
     per-extension tally); the caller supplies only `emit`.

   And one trap worth knowing: on a `makeTestServices` tree,
   `AstDocumentManager.onUpdate` never fires by itself, because the stub builder
   runs no phases. Drive it with the bundle's
   `astDocumentManager.emitUpdate(uri, event)` and check
   `updateSubscriptions(uri)` before believing an empty event list — otherwise a
   negative assertion passes because nothing was ever wired up.
3. **Red first.** Write the assertion, watch it fail for the right reason, then
   make it pass. A characterization test that comes out **red against unmodified
   code is a latent bug** — investigate it, do not adjust the test to match the
   surprising behaviour.
4. **Every test must justify its existence** — it should catch a real class of
   bug. No tautological or vacuous assertions.
5. **Keep it deterministic.** Fake time with `makeFakeClock` (anything routed
   through `services.Clock`); await with `waitFor` / `tick`; never a fixed sleep.
6. **Green means the gate.** Before committing, `npm run check` must pass in
   full, with **0 lint errors and 0 warnings**. Read the LAST line of the run,
   not turbo's task count: turbo is the first element of a long `&&` chain, so
   `Tasks: N successful` can print while a later clause reddens.

## Where things are

- Per-package unit tests: `packages/*/test/`
- Shared test scaffolding: `packages/*/src/testing/` (shipped via `*/testing`;
  the runtime-bound half lives in `src/testing/node/`, shipped via `*/testing/node`)
- Conformance kit: `packages/conformance/` (Vitest, plus one Jest smoke in
  `test/jest/` that exercises the shipped Jest adapter)
- L2 integration + L4 smoke + golden corpus: `examples/order-flow/server/test/`
- L5 Playwright e2e, Theia host: `examples/order-flow/theia-app/test/e2e/`
- L5 Playwright e2e, browser host: `examples/order-flow/browser/test/e2e/`
- The on-ramp example's own suite: `examples/bookstore/server/test/` — it covers
  what `hydranium-cli init` scaffolds, so a regression there means the shape a
  new adopter starts from is broken
- Perf benches: `examples/order-flow/server/test/perf.bench.ts`
