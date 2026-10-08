# Testing

How Hydranium is tested, which tests a change needs, and the traps that make a
test pass without proving anything. The factory and harness conventions are in
**Test support** in [`conventions.md`](conventions.md).

## Strategy

We think in **layers**. Each layer answers a different question; a feature is
well-tested when the layers that apply to it are covered — not when one layer is
exhaustive.

| Layer | What it proves |
|---|---|
| **L0 — Static** | It type-checks: `tsc -b` for sources, `typecheck:test` for tests. |
| **L1 — Unit** | One class/function behaves, collaborators stubbed. |
| **L2 — In-process integration** | Several real collaborators wired through a seam (a server over an in-memory connection). |
| **L3 — Conformance** | An implementation honors a protocol, host-independent (`@hydranium/conformance`). |
| **L4 — Subprocess** | A real server process over its real transport. |
| **L5 — System / E2E** | The whole app through the real UI, in every host the framework claims to run in. |

Cross-cutting techniques layered on top: a **golden corpus** that holds
`serialize(parse(x)) === x` byte-stable, **property tests** with `fast-check`
over the patch/merge algebra, **perf baselines** (root `npm run bench`, see
[`perf-baseline.md`](perf-baseline.md)), and a Stryker **mutation audit**
(`audit:mutation` and `audit:mutation:quick` in `@hydranium/core`) that finds
unasserted behaviour. The last two run on demand, outside turbo, `npm test`
and `npm run check`.

### Picking the layer

- A pure function or one class with stubbed collaborators → L1, in that
  package's `test/`.
- Anything that needs a real grammar, the wire, or several services
  cooperating → an L2 harness test in the example server. Core has no grammar,
  so grammar-dependent behaviour cannot be unit-tested in core.
- A protocol guarantee every head must honor → an L3 conformance check.
- A framework-owned transition (rollback, retry, conflict) is tested where its
  owner lives. A caller-level retry test would duplicate policy Hydranium
  deliberately leaves to adopters.

Reuse the `*/testing` scaffolding before hand-rolling a mock, and add new
scaffolding there by the rules in **Test support**.

## Runner rules and their pitfalls

**No package passes `--passWithNoTests`.** It turns "the runner matched no
files" into exit 0, which no gate can tell from a suite that passed, so a config
or glob change that stops matching would read as green forever. A package that
has no tests yet carries no `test` script at all.

**`testTimeout` does not protect a synchronous test.** `vitest.shared.ts` sets
`testTimeout` once, higher under `CI` than locally: a shared CI executor runs
the suite several times slower, and a slow test is cheapest to find where it is
being written. The timeout is an event-loop timer, so a test body that blocks —
anything built on `spawnSync` or `execFileSync` — runs to completion however
long it takes. Make the test async if the timeout is to mean anything for it.
Under `CI` each package also writes `test-results/junit.xml`; its per-testcase
`time` is the only record of which test is closest to the timeout.

**A quiet run is not a clean run.** LSP harness teardown is quiet because the
harness attaches the way a server entry point does: `withHydraniumLspFeatures`
and `startLanguageServer` drop only a send whose peer is already gone. Once a
services tree exists in the worker, the workspace manager's process-level
`unhandledRejection` listener logs a genuine rejection rather than failing the
test, and Vitest does not report it. Read the log.

**`ModelService.onModelUpdated` never fires by itself on a `makeTestServices`
tree**, because the stub document builder runs no phases. Drive it with the
bundle's `documentBuilder.firePhase(state, document)`, and prove one delivery
before believing an empty event list — otherwise a negative assertion passes
because nothing was ever wired up.

**A disconnect while a request is in flight cannot be asserted from the
client.** `vscode-jsonrpc` rejects every pending request when its connection is
disposed, so hold the request on the server until the transport is gone and
assert on the server's own outcome.

## Writing a test

1. **Red first.** Write the assertion, watch it fail for the right reason, then
   make it pass. A characterization test that comes out **red against unmodified
   code is a latent bug** — investigate it, do not adjust the test to match the
   surprising behaviour. Name the failing run and why it failed under "how you
   know it works" in the pull request description.
2. **Run a control before believing a new test.** Where red-first does not
   apply — a test written alongside the fix it guards, or over code that already
   works — break the code that test covers and confirm THAT test goes red. A
   test that cannot fail is worse than no test, because it reads as coverage.
   Name the control and what it broke under "how you know it works". The commit
   body carries no test evidence: the control is undone before the commit, so
   it is no part of the change.
3. **Every test must justify its existence** — it should catch a real class of
   bug. No tautological or vacuous assertions.
4. **Keep it deterministic.** Fake time with `makeFakeClock` (anything routed
   through `services.Clock`); await with `waitFor` / `tick`; never a fixed
   sleep.
5. **Green means the gate.** `npm run check` must pass in full; read its
   verdict as [The gate](../CONTRIBUTING.md#the-gate) describes.

### A control that refuses to redden

It is a result, not a nuisance: the test does not reach the path it claims to,
and the next move is finding out why rather than rewording the assertion. Some
of the ways that happen have nothing to do with the test:

- **The break stopped the build**, so the task never ran and the green belongs
  to turbo rather than to the suite.
- **A name filter matched nothing.** `-t` / `--testNamePattern` skips every test
  in every matched file and still exits 0, so the run reports success while
  asserting nothing. A file pattern is safe here, since no package passes
  `--passWithNoTests`.
- **The break landed on a source the run does not load.** A package's own tests
  import `src` directly, but an example or end-to-end test resolves
  `@hydranium/*` to built `lib`, so editing `src` without rebuilding changes
  nothing the run can see.

The mutation audit asks the same question over a whole package. It finds
assertions that were never load-bearing; it does not replace the control on the
test in front of you.

## Running tests

`npm run check` is the gate; the root `package.json` names its stages (`test`,
`lint`, `typecheck`, `build`, `build:all`). For the inner loop, run Vitest in
one workspace:

```bash
npm exec -w @hydranium/core -- vitest run test/<file>.test.ts       # one file
npm exec -w @hydranium/core -- vitest run test/... -t 'partial name' # one test
npm exec -w @hydranium/core -- vitest                               # watch
```

### End-to-end (L5)

There is one Playwright suite per host: the Theia app
([README](../../examples/order-flow/theia-app/README.md)) and the browser page
([README](../../examples/order-flow/browser/README.md)). Each README owns its
commands. Neither suite is wired to `test`, so `npm run check` never depends on
a downloaded browser binary. Three traps:

- The Theia app's `test:e2e` and `test:e2e:headed` skip every `@restart` spec,
  so running only those never executes them; `test:e2e:restart` does.
- `reuseExistingServer` is on outside CI, so a stray process on the port gets
  tested instead of yours; a suspiciously fast pass is the tell.
- The web server boots the **built** bundle, so framework changes need
  `npm run build:all` first or you test stale code.

### Install-shape smokes (on demand)

All four drive `scripts/check-packed-consumer.mts`, whose header describes each
mode, and sit outside the regular gate because each performs a fresh npm
install. `HYDRANIUM_KEEP_PACKED_CONSUMER=1` keeps the disposable project.

- `check:packed-consumer` installs the packed server-side packages outside the
  workspace and drives the bookstore server over LSP and the data socket. Run
  it when changing package exports, peers, or server bootstrap.
- `check:init-scaffold` scaffolds with the packed `@hydranium/cli`, as an
  adopter's `npx` does, in each supported shape, then builds, tests and drives
  every head. It shows what an adopter's first install meets, which the
  hand-assembled bookstore consumer cannot. CI runs it as its own job on every
  pull request that changes more than prose.
- `check:published-baseline` runs the consumer smoke against the published
  prerelease. The consumer is this tree's bookstore server, so an example
  already using an unpublished API fails it with no published package at fault.
- `check:prerelease-upgrade` upgrades a consumer of the prerelease `latest`
  names to the candidate tarballs. It prints that baseline; set
  `HYDRANIUM_UPGRADE_FROM` to it to repeat a failure.
