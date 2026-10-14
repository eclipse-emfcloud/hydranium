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

### Titling a test

The CI job summary names each case by its full title, the `describe` titles
joined by the runner with the `it` title last, so one rule keeps that table
reading as one suite. A top-level `describe` takes one of these shapes:

- **A unit**, spelled as code or the CLI spells it: `DataServer`,
  `analyze-heap`, `hydranium-cli --version`. Several units are joined with
  `and`, as in the scenario
  `ProfileCapture and profileWorkload in a real inspector session`.
- **A member**, as `Unit.member` without call parentheses, where the unit is
  the class, interface or namespace the suite tests and has the member,
  declared or inherited: `AstDocumentManager.save`, `AstDocument.create`. A
  title takes this shape when its leading word is the member's code name,
  spelled exactly, and the suite is about that member, whether it calls the
  member directly or reaches it through a public path such as a constructor
  option. English words that only describe a member, such as `text state`,
  stay as written.
- **A scenario**: the unit, units or member, a space, then lowercase words
  naming the scenario: `ClientSession.create races`. A suite over several
  members is a scenario on the unit: `ClientSession open and close`.
- **A property**, as a lowercase statement, optionally about a named unit:
  `the hand-maintained value-flag lists match their parser`,
  `interpolate never throws`. An integration or end-to-end suite names its
  system as a unit, `order-flow diagram in Theia`, or states the situation it
  pins down, `a save followed by the last close`.

Where no shape fits, a short lowercase noun phrase names what the suite
covers, such as a module, a file or a group of units: `the German catalogue`.
A nested `describe` names what it narrows to: a member, a function exported
beside the unit, a scenario or a condition, without repeating the parent's
words. An `it` title is one statement of the behaviour, starting lowercase
unless it starts with a name; in a table of cases it may name the case it
covers instead: `pure insert at start`. A test outside any `describe` is
titled as if its file name were the `describe`. An `.each` title is read as
it renders, with its row values filled in, and a rendered value appears bare,
without quotes.

No title carries a separator of its own: a dash set off by spaces, a semicolon
or a colon, and in a `describe` title also parentheses, brackets or a comma
that sets off a qualifier. The runner already joins the levels, so a second
separator reads as another level. Code in a title goes in backticks, such as a
`virtual:` scheme, and its punctuation is then no separator. A name keeps its
own spelling, so `Logger`, `Save All` and `Ctrl+S` stay as they are.
`check:test-titles` fails the gate on the separators, a colon outside
backticks, a leading capital that is no name and a `$field` in an `.each`
title; the shapes and the qualifier comma are left to review.

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
  normally import its `src` directly, but reach every `@hydranium/*` package
  they name through built `lib`, the package's own published subpaths
  included, as an example's or an e2e test's imports always do; so editing
  `src` without rebuilding changes nothing the run can see.

Others are the test's own:

- **The fixture lacks the hazard's precondition.** `watchModelDocument` takes
  its dedup baseline from a document already in `LangiumDocuments`, so a
  redundant event after a watch can only happen for a document the workspace
  walk never loaded; a sample workspace loads every file and cannot show it.
  Ask what makes the bug possible, and check the fixture has that state.
- **The environment supplies the precondition**, so the control reddens on one
  machine while the assertion cannot fail on any other. `makeScratchWorkspace`
  resolves its root for a temp directory reached through a symlink, as on
  macOS; where `tmpdir()` is already real, removing the resolve stays green.
  Build the precondition inside the test, or say at the assertion what guards
  it.
- **The observable was sampled after the event it meant to exclude.** A
  write's phase notification goes out during the build the write awaits, so it
  reaches the client before the response, and a delta taken after the `await`
  already holds it. Take the baseline before the call, or count absolutely.
- **The wait matched a different occurrence**, which shows as a test passing
  alone and failing in the full gate. An operation, undo, redo, save and
  external rebuild all send `SetDirtyStateAction`; wait on its `reason`, or on
  the observable itself, not on the action's kind.
- **The property cannot move the assertion.** `getModelDocument` builds a
  document nobody opened, so asserting that a replayed open and get both
  answered holds in either order; assert the order itself.
- **The observable is a cached projection that survives the fault.** While a
  document is structurally broken, the GLSP head keeps the graph the client
  already has, so a count read off the diagram does not change with a parse
  failure; the diagnostics and the diagram status do.
- **The break landed on a source the build regenerates.** An example server's
  `test` script runs against its checked-in generated parser, and only `build`
  runs `generate`, so a `.langium` edit changes nothing a package-local run
  sees. Regenerate before reading the verdict, or break hand-written code.

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

Order-flow has one Playwright suite per host: the Theia app
([README](../../examples/order-flow/theia-app/README.md)), the browser page
([README](../../examples/order-flow/browser/README.md)) and the VS Code
extension ([README](../../examples/order-flow/vscode/README.md)), which adds an
extension-host tier on `@vscode/test-cli` for what the extension API can see.
The bookstore's browser host
([README](../../examples/bookstore/host-browser/README.md)) carries the smoke
test `init --hosts browser` emits. Each README owns its commands. No suite is
wired to `test`, so `npm run check` never depends on a downloaded browser or
editor binary. Three traps:

- The Theia app's `test:e2e` and `test:e2e:headed` skip every `@restart` spec,
  so running only those never executes them; `test:e2e:restart` does.
- Order-flow's browser suite and the Theia app's main tiers set
  `reuseExistingServer` outside CI, so a stray process on the port gets tested
  instead of yours; a suspiciously fast pass is the tell. The Theia reconnect
  tier and the bookstore's suite never reuse one, so a stray process fails them
  instead.
- Every tier runs **built** code, the web servers their bundles and the VS Code
  tiers the extension's `out/`, so framework changes need `npm run build:all`
  first or you test stale code.

### Install-shape smokes (on demand)

All four drive `scripts/check-packed-consumer.mts`, whose header describes each
mode, and sit outside the regular gate because each performs a fresh npm
install. `HYDRANIUM_KEEP_PACKED_CONSUMER=1` keeps the disposable project.

- `check:packed-consumer` installs the packed server-side packages outside the
  workspace, with the bookstore's protocol package packed beside them, and
  drives the bookstore server over LSP and the data socket. Run it when
  changing package exports, peers, or server bootstrap.
- `check:init-scaffold` scaffolds with the packed `@hydranium/cli`, as an
  adopter's `npx` does, in each supported shape, then builds, tests and drives
  every head; a shape with a browser host also runs its smoke test, in the
  Chromium the scaffold's own Playwright downloads, which needs that browser's
  system libraries installed. It shows what an adopter's first install meets,
  which the hand-assembled bookstore consumer cannot. CI runs it as its own job
  on every pull request that changes more than prose.
- `check:published-baseline` runs the consumer smoke against the published
  prerelease. The consumer is this tree's bookstore server, so an example
  already using an unpublished API fails it with no published package at fault.
- `check:prerelease-upgrade` upgrades a consumer of the prerelease `latest`
  names to the candidate tarballs. It prints that baseline; set
  `HYDRANIUM_UPGRADE_FROM` to it to repeat a failure.
