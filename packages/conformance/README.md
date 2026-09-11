# `@hydranium/conformance`

The protocol conformance kit — a TCK — for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework.

A TCK is a test suite you do not write: the framework ships the checks, and **you run them against
your own server** to prove it actually speaks each head's protocol. You supply two things — a way to
stand a server up (`connect`) and per-language fixtures (a valid and an invalid model) — and the kit
emits one test per check in your own test runner, alongside your own suites.

Install it if you are building a Hydranium head and want a protocol contract you did not have to
author, and that keeps checking you as the framework moves.

## What it gives you

- **Per-head batteries**, one subpath each: `/data`, `/lsp` and `/glsp`. Importing one never pulls
  another head's protocol types in, so an LSP-only adopter takes no data-head surface.
- **Driver ports rather than adapters.** Each slice names a minimal port — `DataConformanceDriver`,
  `LspConformanceDriver`, `GlspConformanceDriver<TAction>` — spelled in `@hydranium/protocol` types,
  plain coordinates and tiny structural minima. The framework's own harnesses
  (`DataServerHarness`, `LspHarness`, `GlspHarness`) satisfy them **structurally, with no adapter**,
  and so can a hand-rolled driver.
- **Runner-agnostic core.** `ConformanceCheck`, `ConformanceRunner` and `emitConformanceSuite` name
  no test runner and assert with `node:assert/strict`; the thin `/vitest` and `/jest` adapters bind
  `describe` / `it` / `it.skip` / `afterAll`.
- **Skips that are visible, not silent.** A check whose optional fixture input is absent is emitted
  as a named `it.skip`, and every suite prints a ran-vs-skipped summary (`formatSummary`), so a
  half-wired adopter reads as _skipped_ rather than as a green run.
- **A false-green guard in the fixture type.** `LanguageFixture` requires **both** a `valid` and an
  `invalid` model, so an "invalid" model that in fact parses clean fails the diagnostics checks
  instead of passing vacuously.
- **Server-side rendering, opt-in.** Supply `renderedDiagnostic: { locale, expected,
  absentWithLocale }` on a fixture and the `/lsp` battery declares that locale at `initialize`,
  then asserts the fragment appears — and, from `absentWithLocale`, that the untranslated fragment
  DISAPPEARS with the locale and is present without it. It is opt-in because the framework ships no
  catalogue and selects no locale, so a server that renders nothing is correct; and it is a PAIR
  because "the message contains X" alone passes for a server whose English contains X. Omit
  `absentWithLocale` and the control reports skipped rather than being quietly dropped.

## Install

```bash
npm install --save-dev @hydranium/conformance
```

`@hydranium/protocol` is a required peer. The two runners are **optional** peers — `vitest` and
`@jest/globals` — so you install only the one you use, and the core never loads the other. The
package has no runtime dependencies of its own.

## Subpaths

| Subpath    | Contents                                                    |
| ---------- | ----------------------------------------------------------- |
| `.`        | Fixture model + check/runner primitives. No head, no runner. |
| `./data`   | Data-head driver port + `buildDataChecks`.                   |
| `./lsp`    | LSP-head driver port + `buildLspChecks`.                     |
| `./glsp`   | GLSP-head driver port + `buildGlspChecks`.                   |
| `./vitest` | Vitest adapter: `run{Data,Lsp,Glsp}Conformance`.             |
| `./jest`   | Jest adapter: the same three entry points.                   |

Each named subpath also resolves as `@hydranium/conformance/lib/<name>`, so a consumer on classic
`moduleResolution: "Node"` can reach it. The root barrel deliberately re-exports none of the slices.

## Usage

In one test file per head, call the `run*Conformance` function from your runner's adapter subpath —
`@hydranium/conformance/vitest` or `@hydranium/conformance/jest`. Both adapters also re-export the
slice types (driver ports, options, fixtures), so a suite needs a single import site.

Each takes `connect` plus `languages`:

- **`connect`** returns a freshly wired driver and is called **once per check**, so checks cannot
  interfere; the kit disposes the driver afterwards. The data slice wants a server already ready; the
  LSP slice drives the `initialize` handshake itself, so `connect` must **not** pre-initialise; the
  GLSP slice drives `start()`.
- **`languages`** is an array of `LanguageFixture`: `valid` and `invalid` are required and read by
  every slice; every other field is an opt-in whose checks report **skipped with a named reason**
  when it is absent, so an opt-out stays distinguishable from lost coverage. Read the current set
  off the `LanguageFixture` type, which says per field which slice reads it and what supplying it
  claims — the two that carry the most are `edit` (a replacement text plus an `expect(root)`
  predicate, because only you know what "the edit landed" means for your grammar) and `dependent`
  (a document that references `valid`, which is what lets the data slice provoke a cascade). A
  fixture's `uri` and `text` may be thunks, resolved after `connect`, which is how each check gets
  pristine input in a workspace `connect` just created.

The GLSP slice is generic over your action type and takes `GlspFixture` per diagram type — the
fixture builds the native actions and the kit matches responses by `kind`, so no `@eclipse-glsp/*`
type enters the kit.

Then run your normal test command:

```bash
npx vitest run test/data-conformance.integration.test.ts
```

The suite prints, per head, how many checks ran and which were skipped and why. For where this sits
among the framework's test layers, see [`docs/contributing/testing.md`](../../docs/contributing/testing.md).

## Status

Alpha — pre-v0, not yet published. The check batteries are being populated incrementally and the
driver ports are not yet stable — a new check can turn a passing adopter red by design. See the
[repository README](../../README.md) for the current status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](../../NOTICE.md) for third-party notices.
