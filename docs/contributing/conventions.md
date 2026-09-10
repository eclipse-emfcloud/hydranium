# Framework conventions

Patterns adopted across `@hydranium/*` packages. These aren't mechanical
rules — they're load-bearing in places, so this doc captures the
intent so future code stays aligned.

## `src/testing/` subtree

Every package keeps its test helpers (stubs, harnesses, fakes) under
`src/testing/` and emits them to `lib/testing/`. Consumers import via
the `./testing` subpath:

```ts
// in a test file:
import { makeDataServerHarness } from '@hydranium/data-server/testing';
import { makeFakeDocument } from '@hydranium/core/testing';
```

**Why a sibling subtree, not a separate package?**

- Test helpers need access to internal types and protected methods of
  the package they test. A sibling subtree shares the same TypeScript
  compilation unit and types are reachable; a separate package would
  force every internal symbol to be `export`ed for the test package to
  reach it.
- The subpath-import boundary still lets adopters distinguish
  test-only imports at review time (`/testing` in the import line is
  a visible marker) and lets build tooling tree-shake test helpers out
  of production bundles.

**What goes in `src/testing/`:**

- Stub interfaces following the `Stub*` naming convention (typically
  `extends Pick<RealClass, ...>` for compiler-checked alignment with
  the real surface — a class clause can only extend an expression, never
  a type, so this idiom is available to an interface only; see
  `make-test-services` for the pattern).
- Harness builders that bundle a service set + lifecycle into one
  call (e.g. `makeDataServerHarness`, `makeTestServices`).
- Fixture builders that produce structurally-valid AST nodes,
  documents, or descriptors for tests to start from.

**What does NOT go in `src/testing/`:**

- Actual `*.test.ts` files. Tests live in `test/`, never `src/`.
- Anything a non-test consumer would ever import. If you're tempted
  to use a `src/testing/` helper from production code, the helper is
  misplaced — move it to `src/` proper.

## `exports` field — every subpath twice

Every package's `package.json` declares its public surface via the
`exports` field, mapping import paths to compiled artefacts under
`lib/`. A map is **mandatory, not optional** — see "A package with no
map" below for what its absence does. **Every subpath is declared
twice** — once bare, once under `./lib/` — pointing at the same two
artefacts:

```jsonc
{
   "name": "@hydranium/core",
   "exports": {
      ".": {
         "types": "./lib/index.d.ts",
         "default": "./lib/index.js"
      },
      "./testing": {
         "types": "./lib/testing/index.d.ts",
         "default": "./lib/testing/index.js"
      },
      "./lib/testing": {
         "types": "./lib/testing/index.d.ts",
         "default": "./lib/testing/index.js"
      }
   }
}
```

**Why both spellings.** The repo has two module resolvers and neither
reads both forms:

- `moduleResolution: "Node"` (node10) — the `tsconfig.base.json` default,
  and therefore what the Theia client packages and the host-agnostic
  example clients compile under — **ignores the `exports` map entirely**
  and resolves physically. It can reach `@hydranium/pkg/lib/testing`
  and nothing else.
- vite / vitest and `moduleResolution: "NodeNext"` resolve **through**
  the map. They can reach `@hydranium/pkg/testing`, and reject any path
  the map omits.

A subpath declared only bare is therefore reachable from a node10
consumer by **no specifier at all**: the bare form fails `tsc` ("could
not be resolved under your current 'moduleResolution' setting"), and the
`/lib/` form fails at runtime ("is not exported under the conditions").
The failure is misleading rather than loud — it reads as a broken
install in a package whose dependency is correctly declared, and it
stays invisible until some consumer happens to compile under node10.

`npm run check:exports` (`scripts/check-exports-aliases.mjs`) enforces
the pairing, including that the twins point at the *same* target — a
twin aimed elsewhere resolves, so nothing errors and the two spellings
of one subpath quietly deliver different modules.

**The pairing rule is one-directional.** It says a subpath declared
BARE needs a `./lib/` twin, and it does not say the reverse, because
a key already spelled `./lib/x` resolves under both resolvers as it
stands: node10 finds the file physically, and an `exports`-aware
resolver finds the declared key. So a bare alias for it would only be
a second name for one artefact. That is what lets `@hydranium/cli`
declare the CLI binary as `./lib/cli.js` alone — a consumer that
spawns the binary resolves that path by specifier
(`createRequire(import.meta.url).resolve(...)`), and the `bin` field
offers a shim on `PATH` rather than a path.

**A package with no map** is the worst case, not an exempt one, so
`check:exports` fails it. `files` publishes a whole compiled tree, and
with no map every module in it — every internal helper, every command
module — is deep-importable, which makes it public surface that semver
applies to from the first publish onward. Nothing else reports this:
the map's absence is what *permits* the deep import, so no resolution
ever fails and no consumer ever complains. Declare the surface, however
small; two keys is a perfectly good map.

**Assets are the one carve-out.** A key whose target lies wholly
outside `lib/` names a shipped asset rather than a compiled module —
`@hydranium/glsp-client-theia`'s
`"./style/diagram-loading.css": "./style/diagram-loading.css"` is the
only one today. It has no twin and must not grow one: `tsc` emits no
assets, so there is no `lib/style/` to point at, and a bundler is what
resolves a stylesheet. `check:exports` holds an asset key to the two
mistakes it can actually make instead — the target must exist, and
some `files` entry must ship it, or the key resolves in this tree and
404s from the tarball. It also refuses a **wildcard** asset key, which
keeps the "nothing is reachable automatically" property below intact.

**Why `lib/` at all?**

- The `src/` tree stays private — adopters can't accidentally import
  from it, even if their tooling resolves nested paths.
- Keeps the import surface stable across build tooling changes: even
  if we move from `tsc` to esbuild / tsup / etc., as long as the
  output lands in `lib/`, adopter import paths don't change.
- Mirrors the convention used by `@eclipse-glsp/server`, `@theia/core`,
  and most TypeScript-monorepo packages — adopters get a familiar
  shape.

**What this means for new files:**

- No package declares a `./*` wildcard, so nothing is reachable
  automatically. A new module in `src/<name>.ts` is reachable only
  through a barrel that already has an `exports` entry; giving it a
  subpath of its own means adding **both** entries.
- Add a new subtree (e.g. a new `cli/` folder) → put an `index.ts` at
  its root and add `./cli` **and** `./lib/cli` to `exports`.
- Never export from `./src/...` — adopters that do this are taking a
  dependency on the package's internal layout, which we don't intend
  to support.

### The `./node` subpath = the server-only boundary

Anything that imports a `node:*` builtin (or a Node-only dependency)
lives behind a package's **`./node`** subpath and physically under
`src/node/` — mirroring Langium's own `langium` / `langium/node` split
(and `@hydranium/langium`'s `/node` mirror). The rule:

- **The split is three-way: `.` = strictly neutral (no DOM/`window`),
  `./node` = server-only, `./browser` = DOM-dependent — added per-package
  only when such code exists.** We follow Langium's polarity (neutral root,
  named platform exceptions), not GLSP's always-three (`/common` + `/browser`
  + `/node`): neutral dominates an LSP framework, so it is the default and
  platforms are the opt-in. Keep the root *strictly* neutral rather than
  merely "browser-safe" — code that needs a DOM/`window` belongs behind an
  explicit `./browser` subpath, never in the root, or it silently breaks in
  a non-DOM neutral context (a DOM-less worker, SSR, a plain Node consumer).
- **The `.` entry is neutral — it runs in BOTH Node and the browser**
  (the LSP server runs `.` in Node *today*). So it must be free of `node:*`
  imports/globals (else it breaks in a browser) AND of DOM globals (else it
  breaks in Node / a worker). It carries interfaces + pure/portable defaults.
- **`@hydranium/<pkg>/node` is "server-only" by contract.** A browser
  build imports `.` only; a Node host additionally imports `./node` for
  the disk-backed defaults (e.g. `@hydranium/core/node`'s `NodeFileSystem`
  — the framework counterpart to Langium's, supplying the *writable*
  provider — the socket launcher, the `perf_hooks`/`v8` diagnostics, the
  `node:fs` log file-tee sink).
- **The portable default opts the browser in for free.** Where a slot
  has a Node-backed impl, the `.`-entry DI default is the browser-safe
  one (e.g. `FileSystemProvider` → `DefaultEmptyFileSystemProvider`);
  Node hosts opt into disk I/O via `./node`. (An adopter that overrides the
  slot is unaffected by this default either way.)
- **Node specifics inside a portable module are injected, not imported.**
  Where a portable module needs an optional Node capability, expose a
  seam rather than a static `node:` import: the log file-tee writes
  through an installable `LogFileSink` (`@hydranium/core/node` installs
  the `fs` one on load); the session preamble takes injectable
  `systemInfoLines` / `conventionLines` (Node lines from
  `nodeLogPreambleSections()`).
- **Node *globals* go through one accessor module, never raw.** `process.*`
  reads are globals (not imports), so a bundler won't flag them — yet an
  unguarded `process.cwd()` still throws in a browser. So neutral code never
  touches `process` / `Buffer` directly: it calls a guarded *capability*
  accessor from `core/src/util/environment.ts` (`processEnv`, `processPid`,
  `onProcessEvent`, `currentMemoryUsage`). Capability- not
  environment-detection — each tests the specific API (`typeof
  process.memoryUsage === 'function'`), because bundlers inject a *partial*
  `process` shim into browser builds, so `typeof process` alone lies (hence
  no coarse `isNode()`).
- **The guard is enforced, not just convention:**
  -- eslint bans `node:*` imports (+ `@eclipse-glsp/server/node`) across the
     four neutral heads' `src/`, and bans the `process`/`Buffer` globals over a
     wider set — every package that publishes a gated browser-neutral entry,
     because the esbuild probe sees an import but never a global. `src/node/`
     + `src/testing/` (+ `environment.ts` for globals) are exempt;
  -- the committed `check:neutral` esbuild probe
     (`scripts/check-neutral-bundles.mjs`, in the root `check` script) bundles
     each neutral `.` for the browser and asserts zero `node:` errors —
     catching *transitive* pollution the per-file lint can't see;
  -- DOM globals are compile-banned by `lib: ["ES2022"]` (no DOM) in
     `tsconfig.base.json` — but only for a package that INHERITS that `lib`.
     `lib` has no per-directory form, so a package with a genuinely rendering
     `./browser` tier must raise the grant package-wide, which lifts the ban off
     its neutral entries too; the host-facing client packages are in that
     position. So this half of the guard is weaker than the `node:*` half and is
     not uniform: `check:neutral` derives which gated entries it actually covers
     from the tsconfigs and prints both sets, rather than claiming all of them.
     `bare 'path'` is the one allowed builtin (browser-aliasable; the probe
     externalises it).

All three heads carve this way: `@hydranium/core`, `@hydranium/data-server`
(whose `./node` holds the Node diagnostics provider), and
`@hydranium/glsp-server` — whose `./node` holds the
socket launcher (`@eclipse-glsp/server/node`'s `SocketServerLauncher`) while the
`.` entry imports the bare `@eclipse-glsp/server` (browser-swapped via that
package's own `browser` field to its node-free build). A browser GLSP head binds
GLSP's `WorkerServerLauncher` from `./node`'s browser sibling.

### A host-integration package's root barrel follows its upstream

The strictly-neutral-root rule above binds the four **head-neutral** packages,
whose `.` entry is code an adopter runs in any environment. The
`packages/*-theia` tier answers to a different authority: each package exists to
be composed into one host, so its root entry is a question about that host's
conventions — and the ecosystem has no single answer to copy.

- `@theia/core`'s `main` is `lib/common/index.js`: the root IS the neutral tier.
- `@theia/output` and `@theia/workspace` declare no `main` and ship no root
  `index` at all: the root is not a surface, and a consumer names a tier.
- `@eclipse-glsp/theia-integration`'s `main` is `lib/browser/index`: the root IS
  the browser tier.
- `@eclipse-glsp/client`'s `main` is `lib/index`.

**The rule: a host-integration package's root barrel matches the root convention
of the upstream it integrates, and the criterion is what an adopter importing the
bare specifier is entitled to get.** Integrating a package whose own root is its
browser tier, re-export the browser tier. Integrating one that declares no root
surface, declare none — an `export {}` barrel is TypeScript's way of saying "name
a tier", and it is what keeps a `node:` import out of the entry a browser
consumer resolves first. Apply the criterion rather than a target shape:
three-tier is not an ecosystem norm (two of the upstreams above ship
`browser` / `node` only), and a `common/` tier is warranted by having a module
that belongs in it, never in advance.

**A module belongs on `common/` only when its whole dependency closure — values,
types and relative imports alike — is neutral or Theia's own COMMON tier.**
`@theia/core`'s root entry is that tier. Anything reaching `@theia/*/lib/browser`
or `/lib/node` belongs in the tier it names *even when the import is type-only*
and erases at runtime, because the type still binds the reader to that tier.

**A root barrel re-exporting a browser tier is not a neutral entry, and the
comment at its declaration must not imply that it is.** The tier it re-exports
can require a DOM at module load and a bundler with a loader for the stylesheets
its dependencies import, so such a root loads in a frontend build and nowhere
else — not in a DOM-less worker, not in plain Node. What the re-export buys is
the bare specifier an adopter of that upstream expects; what it costs is root
loadability outside a frontend, which is why the `./node` tier of such a package
stays reachable by subpath only.

## Log-output formatters live as `format*` methods on owners

Per-instance helpers that format a thing for a log line or error message
live as methods on the class that consumes them — never as flat utility
functions. **`protected` unless another package reads them**: the whole point
is that an adopter subclass can enrich the output, which `protected` already
allows, so widening past it needs a caller outside the declaring package to
justify it. `HydraniumDocumentBuilder.formatBuildStatus` is public for exactly
that reason — the GLSP head builds its own diagnostics from it.

Examples on framework classes:

- `HydraniumDocumentBuilder.formatBuildStatus(uri)`
- `HydraniumDocumentBuilder.formatListener(listener, index)`
- `HydraniumGlspSubmissionHandler.formatSourceRoot(root)`
- `DefaultIntegrityService.formatRule(rule)`
- `DefaultIntegrityService.formatNode(node)`

**Why methods, not flat utilities:**

- Adopters routinely want to enrich these (one renders `formatUri` as a
  workspace-relative path, which every line the builder emits then picks
  up, and emits per-shape counts via `formatSourceRoot`).
  Override-via-subclass keeps the override local to the owner and
  preserves access to `this`-state the formatter often needs.
- Each formatter has exactly one consumer (the owner's own log line).
  There's no cross-cutting "describe this thing of unknown type" call
  pattern that would justify a central registry or strategy service.
- TypeScript bivariance lets subclasses widen parameter types in
  overrides (e.g. an adopter `formatNode` that takes a more specific
  AST shape) without breaking the parent contract.

**Default impls** should be useful out of the box but tightly scoped —
adopters override to enrich, not to replace boilerplate. JSDoc on each
default should state what it returns AND name realistic adopter
overrides (e.g. `formatNode`'s JSDoc mentions
`'Mapping(source=X, target=Y)'` as an example domain-specific
enrichment).

**Naming:** `format*` (not `describe*`) — matches the existing `Format`
namespace in `protocol/logger.ts` (`Format.timestamp`, `Format.elapsed`,
`Format.bytes`) and signals "produces a string for output" rather than
the more ambiguous `describe`.

**When NOT to use a method:**

- Trivial single-line formatting consumed at exactly one site with no
  realistic adopter override (e.g. a logger component-prefix
  composition like `rule.label ?? rule.id` — inline at the call site).
- Stateless cross-cutting primitives (e.g. `Format.timestamp`,
  `Format.bytes`) — flat namespace functions are fine because they
  share no instance state with their callers.

The flat-utility option is reserved for primitives. Entity-formatters
go through the method convention.

## Configurable options (`ObservableValue<T>` / `MaybeObservableValue<T>`)

Service constructor options that adopters might want to bind to a user
setting accept a `MaybeObservableValue<T>` (in `@hydranium/protocol`) — either a
plain `T` (compile-time constant) or an `ObservableValue<T>` (a live
`{ value, onChange }` cell). The consumer normalises once with
`ObservableValue.from(input)` and reads `.value` at the point of use; a
constant becomes a cell whose `onChange` never fires, so call sites
never branch on shape. The user-setting source is the `Settings`
namespace (`Settings.value` / `Settings.number` / `.boolean` / `.string`
in `@hydranium/core`), which binds an LSP configuration section and
yields an `ObservableValue<T>`.

```ts
import { type MaybeObservableValue, ObservableValue } from '@hydranium/protocol';
import { Settings } from '@hydranium/core';

interface MyServiceOptions {
   debounceMs?: MaybeObservableValue<number>;
}

class MyService {
   protected readonly debounce: ObservableValue<number>;
   constructor(services: ServerSharedServices, options: MyServiceOptions = {}) {
      this.debounce = ObservableValue.from(options.debounceMs ?? 0);
   }
   // read the live snapshot where it's used:
   //   this.clock.setTimer(fn, this.debounce.value);
}

// Adopter wiring, plain constant:
new MyService(services, { debounceMs: 500 });
// Adopter wiring, bound to `my-language.editor.updateDelayMs`:
new MyService(services, {
   debounceMs: Settings.number({ services, configuration: 'editor', key: 'updateDelayMs', default: 500 })
});
```

**Rule of thumb.** Widen a knob to `MaybeObservableValue<T>` only when BOTH
hold:

1. **It maps to a user setting** — a JSON-primitive an adopter might bind
   (number / boolean / string / enum: debounce windows, slow-warn or timing
   thresholds, feature flags, log levels). Not functions, and not structural
   choices that wouldn't change between sessions (option names, file
   extensions, ports, serializer indentation).
2. **It is read at the point of use** — so a live change actually takes
   effect on the next read. A value read *once* into a long-lived stateful
   resource stays plain `T`, because a live change couldn't take effect
   without re-arming that resource: `setInterval` periods, a socket `port`
   passed to `listen()`, a flag that gates one-time listener registration.
   Widening such a value would advertise a liveness the consumer can't
   honour. (Examples kept plain for exactly this reason: the event-loop /
   memory monitor `intervalMs`, `DocumentBuilder.logLevel` / `loggedPhases`,
   `GlspServerOptions.port`.)

Cost of widening is one `ObservableValue.from` at the constructor (read
`.value` at use); the alternative is forcing adopters to subclass to bind any
config-bound option. Widening a plain `T` to `MaybeObservableValue<T>` later
is non-breaking, so adopt case-by-case as demand surfaces. Normalise each
option into its OWN field in the constructor (as `ModelService`,
`DocumentUpdateHandler`, `DocumentValidator`, `DocumentBuilder` do) — flat
options, no bundled "resolved options" struct or `resolveOptions` indirection.

**Lifecycle order:** the constructor normalises the input; for a
setting-bound cell the `.value` getter returns the `default` until the
first fetch resolves (after the client's `initialized` notification, when
Langium's `ConfigurationProvider.ready` resolves), then reflects each
`didChangeConfiguration` push live. Reading `.value` per use always sees
the current snapshot — no subscription bookkeeping at the consumer.

### Multi-grammar adopters: the `configurationRoot` slot

`Settings.value` defaults its `root` argument (LSP section name) to
`services.lsp.configurationRoot`. The framework default binding
returns `services.ServiceRegistry.all[0]?.LanguageMetaData.languageId`
— the right answer for single-grammar adopters, who never need to
override.

Multi-grammar adopters have two options:

- **Pass an explicit `root` to every `Settings.*` call.** Cleanest
  when the configurable values themselves know which grammar they
  belong to (e.g. a service constructed per-grammar).
- **Rebind `lsp.configurationRoot` to a function** that selects the
  intended section. Cleanest when one shared service consumes values
  scoped to a single canonical grammar (often the primary user-facing
  one); the slot override centralises the choice and `Settings.*`
  call sites stay terse.

Adopters MUST NOT leave `configurationRoot` at the framework default
when multiple languages are registered AND they want config-bound
options to read from a specific grammar's section — the registry-order
fallback is deterministic but not principled. The default binding warns
in both degenerate cases: when more than one language is registered — it
picks the first by registration order, which is an accident of
registration rather than a decision — and when none is, which typically
means the grammar-generated shared module wasn't composed before
`createServerSharedModule`; that second case also falls back to
`'plaintext'` so the framework still boots in a degenerate harness.

## Constructor shape — `(services, options = {})` for every bound class

Every class bound in a framework module takes `(services, options = {})`.
Classes that are NOT bound in any module — pure data structures, utility
types, value objects returned from service methods — take their data
directly. They are not part of the dependency-injection graph and don't
pretend to need services they don't use.

**Quick test:** open the module factory file (`langium/module.ts` /
`langium/language-module.ts` / head-specific module files), search for
the class name in a binding. Bound → `(services, options)`. Not bound →
data-direct.

### Four auditable rules

1. **Services-first.** Every bound class accepts `services` as the first
   constructor argument. Type as `HydraniumLanguageServices` /
   `ServerSharedServices` / `ServerSharedServicesMinimal` /
   `LangiumCoreServices` — whichever is the narrowest applicable slice
   for the class's actual reads.
2. **Options-second.** Every bound class accepts an optional `options`
   object as the second argument — `options: XOptions = {}` — even if
   no options exist today. Adding fields to `options` later is
   non-breaking; subclasses that don't customise omit the argument
   entirely.
3. **No redundant deps.** A constructor signature `(services, X, ...)`
   where `X` is reachable from `services` (or from `services.shared`,
   etc.) is the smell. Drop `X`; derive it from `services` inside the
   body. Exception: `X` genuinely lives on a different tree than what
   `services` types as — in that case, tighten the `services` type so
   the dependency IS reachable.
4. **Narrow services type when feasible.** If the class only consumes
   `ProjectManager` and `LangiumDocuments`, declare
   `services: ServerSharedServicesMinimal` (or define a tighter slice)
   instead of full `ServerSharedServices`. The narrowed type documents
   the dependency contract at the source.

### Pure-data exception (NOT bound, take data directly)

| Type | Why |
|---|---|
| `Registry<T>` | Generic data structure constructed inside other services as a field |
| `Disposable` / `DisposableCollection` / `Deferred` / `MaybePromise` | Utility types in `@hydranium/protocol` |
| Generated AST classes | Data |
| `CandidateScope` / `ScopedReferenceInfo` / `TransferDocument` / `TransferElement` | Value objects returned from service methods |
| `Scope` impls used internally (`MapScope`, `StreamScope`) | Langium-supplied combinators |

### Why this shape — matching Langium and future-additivity

`(services, options)` matches Langium's `DefaultScopeProvider(services)`
/ `DefaultLinker(services)` constructor pattern; adopters subclassing a
framework service write `super(services, options)` without thinking
about parameter shape. The `options` second argument means future
configuration additions are non-breaking — existing call sites that
omit `options` keep compiling, new adopters that need the option pass
it. The pattern also keeps the dependency-injection graph navigable:
opening the module file shows every bound class's instantiation in one
place, with a uniform binding shape (`services => new X(services,
options)`).

### `LogNameOptions` — instantiation tracing convention

Every framework-bound service whose `services` parameter can reach the
framework `Tracer`/`Logger` (i.e., `ServerSharedServicesMinimal`,
`HydraniumLanguageServices`, `ServerLanguageServices`, or
`ServerSharedServices` — anything wider than upstream Langium's bare
`LangiumCoreServices`) declares its options interface to extend
`LogNameOptions` from `@hydranium/core` (exported via
`langium/diagnostics/logger.ts`):

```ts
export interface LogNameOptions {
   readonly logName?: string;
}
```

`logName` reads from the adopter's perspective — "the name this service
appears under in the log". It is **distinct from** `LspLoggerOptions.component`
— the latter is the logger's own identity field (matches
`AbstractLogger.component` and `Logger.for(component)`'s argument); `logName`
labels a service that *derives* a tracer.

**Every service holds a `Tracer`, not a bare `Logger`** — `Tracer extends
Logger`, so one `protected readonly tracer: Tracer` field covers both emission
(`this.tracer.info(...)`) and timing/profiling (`this.tracer.time(...)`). The
constructor stores it and emits a single instantiation trace via a fluent
one-liner — the emit methods (`error`/`warn`/`info`/`debug`/`trace`/`log`)
return `this`, so `.for(...).trace(...)` yields the tracer:

<!-- snippet-skip: bare constructor body, shown outside its class -->

```ts
constructor(services: HydraniumLanguageServices, options: SomeOptions = {}) {
   // ... wire instance state ...
   this.tracer = services.shared.Tracer.for(options.logName ?? 'Integrity').trace('instantiated');
}
```

(For services typed at `ServerSharedServicesMinimal` / `ServerSharedServices`
the path is `services.Tracer.for(...)` without the `.shared` indirection.)
`new DefaultTracer()` defaults its logger to a `NoopLogger` and its clock to a
`SystemClock`, so a tracer is cheap to construct in tests and degenerate hosts.

**Choosing the `logName` fallback** (the label used when the adopter passes none):

- a **fixed curated string** (`'Integrity'`, `'ModelService'`, `'ScopeProvider'`)
  for a single canonical implementation — a short stable label beats the class
  name and survives renames;
- **`this.constructor.name`** where the slot has swappable strategy bindings or
  is routinely subclassed (key providers, file-system providers, project
  managers, serializers, the reference candidate provider) — so the log shows
  which implementation actually ran.

**GLSP states / submission handlers** are instantiated per-request by the GLSP
DI container (not `(services, options)`), so they carry no `logName` field.
`AbstractHydraniumGlspState` instead injects the per-class caller-tagged
`HydraniumTypes.Tracer` (`baseTracer`) — the binding (`start-glsp-server` /
`glsp-harness`) labels it with the runtime subclass name (e.g. `OrderFlowGlspState`)
via `getRequestParentName` — and derives the URI-tagged `_tracer` in
`setSourceRoot` (`this._tracer = this.baseTracer.withUri(uri)`); the
`tracer`/`logger` getters fall back to the injected base before then, so logging
is never `undefined` (no `@postConstruct` needed). Adopters wanting a different
label override `setSourceRoot` and derive via `this.baseTracer.for('Name').withUri(uri)`.

**Tests** fill a fake services tree's `Tracer` slot with `makeNoopTracer()` (or
`makeCapturingTracer()` to assert on emitted output) from
`@hydranium/core/testing`, rather than hand-rolling a tracer mock. Code that
takes a bare `Logger` (not a `Tracer`) uses the sibling `makeNoopLogger()` /
`makeCapturingLogger()` from the same subpath — never a `{ for, sub, with, … }
as unknown as Logger` stub, which omits methods and drifts from the real
surface. `makeCapturingTracer` is itself just `makeCapturingLogger` wrapped in a
`DefaultTracer`, so both capture through one threshold-gated sink (set the level
with `Logger.setLevel(...)` — `'trace'` captures everything).

The framework's default `Logger` level is `'info'`, so trace lines are
**no-ops in production runs**. Adopters who want startup-instantiation
visibility (e.g. to verify DI wiring) flip the level via
`Logger.setLevel('trace')` or the LSP-config-bound section before
workspace load.

A service taking `services: LangiumCoreServices`-only has no framework
Logger to reach and would have to skip this convention; none remain.
Serializers, scope computation, the AST-description provider and the
positional key provider all take `HydraniumLanguageServices`
deliberately, so the convention applies uniformly rather than to
whichever services happen to be widened.

## Typeguards and namespaces

The framework sits at the intersection of two ecosystem conventions for
typeguards: the AST-tooling camp (Langium, the TypeScript compiler API,
Babel, ESLint — all free-function `isFoo(x): x is Foo`) and the
LSP-protocol camp (`vscode-languageserver-types`, GLSP, Theia, Sprotty —
all namespace `.is()` typeguards on the companion namespace of the
type). Adopters' Langium-generated AST typeguards are free functions
(Langium-cli output, not under framework control), so the framework
follows AST-tooling style for its own typeguards to keep adopter
callsites consistent. Three rules apply:

### Rule 1 — Framework-defined typeguards are free functions

Every typeguard the framework defines uses
`export function isFoo(x): x is Foo`. No namespace-style typeguards on
framework-owned types.

<!-- snippet-skip: signature forms with elided `{ ... }` bodies -->

```ts
// Yes — free-function form
export function isPublicTier(description: AstNodeDescription): description is TieredAstNodeDescription & { readonly tier: 'public'; readonly projectId: string } { ... }
export function isLogThreshold(value: unknown): value is LogThreshold { ... }
export function isPromiseLike<T = unknown>(value: MaybePromise<T>): value is PromiseLike<T> { ... }

// No — namespace `.is()` form on framework-owned types
export namespace LogThreshold {
   export function is(value: unknown): value is LogThreshold { ... }   // not used
}
```

### Rule 2 — Namespace for factories and static utilities, never for typeguards

A declaration-merged namespace IS allowed (and encouraged) for grouping
factory methods, static utilities, or type-associated constants under
the type identifier. Examples already in the framework:

- `ReferenceSource.document(uri)` / `.element(name)` /
  `.synthetic(uri, type)` — variant factories on a discriminated union
- `ReferenceContext.builder()` / `ReferenceRequest.builder()` — staged
  builders enforcing the `source -> path -> property (-> value)` order;
  `ReferenceRequest.from(context, candidate)` promotes a held context with a
  selected candidate's value (find -> select -> resolve)
- `SyntheticStep.of(prop, type)` / `.chain([...], [...])` — variant
  factories
- `Disposable.create(...)` — factory
- `Logger.setLevel(...)` / `.getLevel()` / `.isLevelEnabled(...)` —
  static utilities on the service-like type
- `Format.timestamp(...)` / `.elapsed(...)` / `.bytes(...)` — formatters
- `IntegrityPhase.Parsed` / `.Linked` / `.toString(...)` — type-associated
  constants + utilities

A namespace is NEVER used to host a typeguard. The free-function
`isFoo` pattern is the canonical form. The split keeps grep / IDE
"find references" behaviour predictable: `isFoo` always lands on the
typeguard, `Foo.bar` always lands on a factory or utility, never both.

### Rule 3 — Consume upstream libraries in their style

When the framework imports types from upstream libraries that use
namespace `.is()` conventions (`vscode-languageserver-types`, GLSP,
Theia), call those typeguards in upstream style at the use site. The
framework doesn't re-export them under a different convention and
doesn't define competing typeguards on upstream-owned types.

<!-- snippet-skip: signature forms with elided `{ ... }` bodies -->

```ts
// GLSP type consumed by the framework — call in upstream GLSP style
import { ChangeBoundsOperation } from '@eclipse-glsp/server';
if (ChangeBoundsOperation.is(action)) { ... }

// Framework-defined typeguard — free-function style
import { isPublicTier } from '@hydranium/core';
if (isPublicTier(description)) { ... }
```

This is a pragmatic carve-out rather than a framework convention:
don't fight upstream conventions when consuming upstream types. The
free-function rule governs only typeguards that the framework itself
defines on framework-owned types.

## `*Protocol` = an RPC wire-contract interface

The `Protocol` suffix is reserved for **RPC wire-contract interfaces** —
the typed method surface that lowers, method-by-method, to JSON-RPC wire
calls (each method name → `<namespace><methodName>`). It applies to BOTH
the composable fragments AND their compositions:

- **Fragments** are role-explicit: `DocumentServerProtocol` /
  `ProjectServerProtocol` / `ReferenceServerProtocol` (server-exposed
  request surfaces) and `DocumentClientProtocol` / `ProjectClientProtocol`
  (server→client notification surfaces). The `Server`/`Client` role marker
  lives on the fragment so a document's server-requests and its
  client-notifications don't both want to be `DocumentProtocol`.
- **Compositions** are interfaces that `extends` the fragments:
  `DataServerProtocol = Document & Project`, `DataClientProtocol =
  Document & Project`; an adopter composes its own
  (`AcmeServerProtocol = Document & Project & Reference & Grammar`).
- **Implementation classes stay bare** — `DataServer implements
  DataServerProtocol`, `AcmeServer`. The bare name reads as
  "implementation, not contract."
- **Service interfaces stay bare** too — `Logger`, `NameProvider`,
  `ProjectManager`, `ModelService` are NOT `*Protocol`; they are in-process
  service contracts, not wire surfaces. Reserve `Protocol` for the wire.

Each `*Protocol` fragment pairs with an `as const satisfies
ReadonlyArray<keyof <Fragment> & string>` method-name list (used as the
`createRpcProxy` `localMethods` / `bindRpcMethods` allowlist) so the list
and the interface cannot drift.

### `*Protocol` names a typed method-surface — not "anything on the wire"

The suffix is reserved for a **typed method-surface RPC interface** (a
multi-method contract that lowers method-by-method to JSON-RPC). That shape
exists in exactly one place — the **data-server head** (`protocol/src/data/*`):
`DataServer` ↔ `DataClientProtocol` over a plain `vscode-jsonrpc`
`MessageConnection`, with the `createRpcProxy` / `bindRpcMethods` /
`methodNamespace` / `*_PROTOCOL_METHODS` machinery. It is the only head where
the framework defines its own RPC method surface from scratch, so it is the
only head the rule governs.

The framework has **other** client↔server wire communication that is NOT
shaped as a method-surface interface and therefore correctly carries no
`*Protocol`. Naming the inventory so the absence reads as deliberate:

- **Port-discovery request** — `publishPortOnLspConnection(lspConnection,
  command, port)` registers a single custom LSP request
  (`onRequest(command, () => port)`); a client (`findPort` in the Theia
  forwarders) calls `sendRequest(command)` to learn the head's socket port
  after the LSP handshake. This is framework-owned wire traffic, but it is a
  *single command*, not a method surface — its contract is the exported
  command-string constant (`DATA_SERVER_PORT_COMMAND` in `protocol`; the
  GLSP / model-server port commands are adopter-defined) plus the structural
  `LspConnectionLike.onRequest<void, number>` shape. There is no multi-method
  interface to name, so there is nothing to suffix.
- **GLSP head** — rides `@eclipse-glsp`'s Action protocol: the wire contract
  is a set of dispatched `Action` classes (each with a `KIND`), the upstream
  idiom, not a method-surface interface. The framework defines none of its own
  (adopter actions like `OpenElementEditorAction` live adopter-side); it
  extends `@eclipse-glsp/server` / `@eclipse-glsp/client` and byte-forwards
  over `AbstractSocketForwardingConnectionHandler`.
- **LSP head** (folded into `core/lsp`) — rides `vscode-languageserver`: the
  wire contract is LSP itself (the spec's JSON-RPC method set, driven by
  Langium's `LanguageServer`). The framework's LSP code is *overrides on*
  Langium's machinery (document-update handler, completion provider) plus the
  port request above — not a custom method surface.

So the discriminator is **shape, not transport**: a typed multi-method RPC
interface the framework owns → `*Protocol`; a single command, an Action-class
protocol, or an upstream JSON-RPC method set → no suffix (there is no
framework method-surface interface to carry it). A future framework-owned RPC
*method surface* would adopt the suffix; these other forms never do.

## Capability negotiation — decided convention, populated additively

The framework has ONE convention for how a server advertises optional
behaviour to a client, so future capabilities are *discovered* rather than
*assumed*. As of v0 there are NO capabilities to advertise; this section
freezes HOW they will be, so the first real one is a non-breaking,
ad-hoc-free addition.

**What counts as a capability.** A model-service-contract feature a client
must branch on: optimistic-concurrency / versioned updates (does the server
honour a `version` and throw `ConflictError`?), conflict-resolution
semantics (reconcile / force / none), foreign-update recording granularity
(field-level vs whole-document). **NOT** LSP- or GLSP-native capabilities —
LSP already advertises its feature set via `ServerCapabilities`, GLSP via
`InitializeResult.serverActions`; a client reads those from their native
systems and the Hydranium descriptor never mirrors them. It carries only
model-service-contract features neither native system covers.

**Direction: server → client.** The server advertises; the client reads and
adapts. That is what makes it a gate — a client that cannot read a capability
has no choice but to assume the server's behaviour. Shape the seam so a
`client → server` direction (server tailoring behaviour to what the client
supports) can be ADDED later; v0 is advertisement only.

**Per-head, through each head's own handshake — never a cross-cutting
channel.** The three protocol heads run independently (a deployment may
expose the data / model-service head with no LSP head), so a channel that
assumes some other head is present is wrong. When it lands, each head will
advertise the SAME descriptor through ITS OWN native handshake:

- data / model-service head → the `waitForReady()` reply (the readiness gate
  every client already awaits before its first request);
- LSP head → `ServerCapabilities.experimental[HYDRANIUM_CAPABILITIES_KEY]`
  (the LSP-spec home for non-standard server capabilities);
- GLSP head → the GLSP `InitializeResult`.

This is what "reuse the existing handshakes, don't invent a third" means:
each head uses its own gate; no bespoke negotiation service.

**Descriptor shape (when it lands).** One shared
`HydraniumServerCapabilities { schemaVersion; features }` in
`@hydranium/protocol`, read from a DI-bound provider slot (interface +
`DefaultCapabilitiesProvider` — a genuine swap point per the class-role
conventions, so it gets an interface; it reads `services` so it can DERIVE).
`features` is a typed interface that grows by OPTIONAL fields, so each added
capability is non-breaking and an absent field reads as "not supported".

**Sourcing a flag — derive / assert / lift-first, never a constant.**

- **Derive** from a governing slot/option where one exists, so the advertised
  value reflects the single source of truth and cannot drift from actual
  behaviour.
- **Assert** only a true implementation invariant with no config knob (e.g.
  version-checking is inherent to `ModelService.update`); the owner sets it,
  a subclass that drops the behaviour overrides it.
- For behaviour currently HARDCODED with no governing slot (e.g. recording
  granularity — `HydraniumGlspRecordingCommand` records a whole-source-model
  patch today; AST field-level is unbuilt), **lift it into a slot first, then
  derive.** Never advertise a hardcoded constant — that is the drift the
  derive rule exists to prevent.

**Why no code at v0.** Every head already has a non-breaking place to add the
descriptor later (widen `waitForReady`'s `void` return; `experimental`;
`InitializeResult`), and framework capabilities are opt-in with safe
conservative defaults, so the seam and its first flag land together
additively with no break. The v0 deliverable is this frozen convention; the
code rides the first real capability, deferred until one exists.

## Class role-name conventions — `Abstract*` / `Default*` / `Hydranium*`

Exported class names carry a role prefix so the kind is loud at the
import/binding site. Three prefixes, plus bare descriptive names.

- **`Abstract*`** — an abstract class with **unimplemented abstract
  members** (its own, or inherited from an upstream base). The prefix is
  honest: you cannot instantiate it; a subclass must fill the abstract
  members in. Examples: `AbstractLogger` (abstract `emit`/`derive`),
  `AbstractSerializer` (abstract `serializeNode`/…), `AbstractProjectManager`
  (abstract `isProjectDescriptor`/`parseProjectDescriptor`),
  `AbstractHydraniumGlspState` (abstract `updateSourceModel`).
  **Do NOT mark a class `abstract` (or prefix it `Abstract`) when it has no
  abstract members** — if it ships complete default behaviour, make it a
  concrete class (adopters can still subclass a concrete class). This is why
  the GLSP app-module and the GLSP storage/submission/contribution bases are
  concrete: an adopter that overrides nothing still gets a working head.

- **`Default*`** — the concrete default implementation of a framework-defined
  interface, paired with a bare-named interface and bound by default in a
  module (adopters rebind to swap). Examples: `NameProvider` +
  `DefaultNameProvider`, `IntegrityService` + `DefaultIntegrityService`,
  `WritableFileSystemProvider` + `DefaultFileSystemProvider`. A multi-impl
  family with no single default uses descriptive bare names instead
  (`JsonSerializer`/`YamlSerializer`, `NameBasedKeyProvider`/`PositionalKeyProvider`,
  `SystemClock` paired with the test `makeFakeClock`), optionally with a
  `Default*` value+type alias naming the chosen default
  (`DefaultElementKeyProvider = NameBasedKeyProvider`).

- **`Hydranium*`** — a framework class that **overrides/extends an upstream
  Langium/GLSP/Theia class** (no framework interface of its own; it
  specialises the upstream type). The brand prefix marks "the framework's
  version of the upstream X" and, crucially, **avoids colliding with the
  upstream `Default*X`** that adopters also import. Examples:
  `HydraniumDocumentBuilder` (← Langium `DefaultDocumentBuilder`),
  `HydraniumScopeProvider` (← `DefaultScopeProvider`), `HydraniumTextDocuments`
  (← `NormalizedTextDocuments`), `HydraniumServiceRegistry` (← `DefaultServiceRegistry`).
  The glsp packages use a `HydraniumGlsp*` sub-namespace for their own
  concepts (`AbstractHydraniumGlspState`, `HydraniumGlspIndex`, …) — `Hydranium` +
  `Glsp` + the concept, not the upstream class name; a family with several
  variants qualifies the brand name with a leading discriminator
  (`FullTextHydraniumGlspState`, `ReconcilingTransferHydraniumGlspState`).

- **bare descriptive** — value objects, errors, utilities, transport
  forwarders, and multi-impl-family variants. The connection-handler family
  is bare (`AbstractSocketForwardingConnectionHandler` base, `DataServerConnectionHandler`,
  `GlspServerConnectionHandler`) — a transport-forwarder category distinct
  from the `HydraniumGlsp*` runtime family. **A framework-original service
  that is its own contract also stays bare** — a sole-implementation class
  the framework authored from scratch (not specialising an upstream `Default*`,
  so no `Hydranium` brand; no separate framework interface, so no `Default`
  pairing) that adopters *extend by subclassing*: `ModelService`,
  `TransferEncoder`, `AstDocumentManager`, `BuildPipelineIntegration`,
  `ValidationContributionCollector`, `SelfSaveRegistry`, `CstResidencyService`.

### Service shape — an interface only for the swap case

This taxonomy IS the answer to "should every framework DI service ship a
three-piece `ServiceXxx` / `DefaultServiceXxx` / `ServiceXxxOptions` set?"
— **no.** A service carries a bare-named framework interface **only when its
slot is a genuine swap point** — a narrow contract an adopter replaces
wholesale, or whose framework default is a no-op / thin / throwing stub the
adopter is expected to supply. Those are exactly the `Default*` cases
(`NameProvider`/`DefaultNameProvider`, `IntegrityService`/`DefaultIntegrityService`,
`ReferenceBuilder`/`DefaultReferenceBuilder`, the cross-head infra
`Logger`/`Tracer`/`Clock`/`FileSystemProvider`, …). `Serializer` is the same
shape with an unexported default: its throwing stub is module-private, so the
adopter has a slot to bind but no default class to subclass.
Everything else has NO interface on purpose:

- a **`Hydranium*`** class specialises an upstream type — the upstream
  surface is the contract; a parallel framework interface would just
  duplicate it;
- a **bare framework-original service** (above) has exactly one real
  implementation that adopters build *on* via `super` — an interface would
  restate the whole class surface for zero adopter benefit, and Langium DI
  is structural, so a subclass already satisfies the slot type with no
  nominal interface (`OrderFlowScopeComputation extends
  HydraniumScopeComputation`, `AcmeModelService extends ModelService`,
  `OrderFlowProjectManager extends AbstractProjectManager`);
- **`ProjectManager`** and **`Serializer`** are the three-level cases —
  interface + `AbstractProjectManager` (abstract members) + concrete
  `SingleProjectManager`; interface + `AbstractSerializer` (abstract members)
  + concrete `JsonSerializer` / `YamlSerializer` — because each has multiple
  *framework* concrete implementations, which is what earns the named
  interface.

The **options** piece is an orthogonal axis, not a mandatory third slot: a
`ServiceXxxOptions` type exists only where a service has a config-bound knob,
and is added on demand (see "Configurable options" above). "No options type"
is the common, correct state, not an omission.

### GLSP DI tokens — the `HydraniumTypes` registry

The framework's GLSP-side services are injected via Inversify tokens that
live grouped in a single `HydraniumTypes` registry object
(`@hydranium/glsp-server`), NOT as top-level `Hydranium<Role>` consts:

<!-- snippet-skip: decorator and bind lines shown outside a class and a container -->

```ts
@inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;
bind(HydraniumTypes.DiagramLanguage).toDynamicValue(/* … */).inSingletonScope();
```

Grouping decouples **token identity from class name** — `HydraniumTypes.SharedCoreServices`
can be typed to the `ServerSharedServices` shape without the token name
and the type name colliding (the bug that motivated the registry). The
field type is always the real interface/class (`ServerSharedServices`,
`ServerLanguageServices`, `ConflictResolver`, …), imported directly;
there is no merged token-and-type alias. Mirrors GLSP's own `TYPES` idiom.

No PER-LANGUAGE service gets a token of its own — only the language does, via
`HydraniumTypes.DiagramLanguage`. A component that injected an
`ElementKeyProvider` / `NameProvider` / `ScopeProvider` / `CandidateProvider`
directly would apply the diagram's grammar to nodes reached through
references, which live in other documents; `modelState.diagramLanguage` and
`modelState.<role>For(node)` make that choice explicit at the call site.

## Package naming — `<head>-<role>-<platform>`

Most `@hydranium/*` package names decompose into up to three slots, in this
fixed order. **The exceptions are the tooling packages** — `cli`,
`conformance` and `langium` — which name a tool or a chokepoint rather than a
position in the head/role/platform grid, and take a bare descriptive name:

- **`<head>`** — the protocol head: `glsp`, `data`, `lsp`. (`glsp-server`,
  `data-server`, `data-client-theia`.)
- **`<role>`** — one of three values: `protocol` (the wire contract —
  types, RPC interfaces, method/prefix constants, transfer shapes,
  wire-serializable errors), `server` (a process that owns a head and
  exposes it over a transport), or `client` (the consuming-side
  integration). Note `*-client-theia` spans both its Theia `browser/`
  AND `node/` — "client" means *the client side of the protocol*, not
  "frontend".
- **`<platform>`** — host suffix (`-theia`, `-vscode`), present only when
  the package is host-coupled. Omitted when platform-agnostic
  (`glsp-server`, `data-server`); `protocol` is *always* agnostic so it
  never carries one.

### Ordering — most-significant first, optional last

The order is fixed at `<head>-<role>-<platform>` because:

1. **An optional dimension must trail.** Platform is the optional slot —
   absent on agnostic packages. If it led (`theia-glsp-client`), then
   `glsp-server` (no platform) and the Theia client would stop sorting
   together and the head's stack scatters. With platform trailing, the
   whole head clusters regardless of host-coupling: `glsp-server`,
   `glsp-client-theia`, `glsp-client-vscode`. You can always omit a
   *trailing* segment cleanly; never a leading/middle one.
2. **Cluster by the most significant axis.** The protocol head is the
   framework's spine ("three heads at the same tier"); adopters reason
   head-first. Role outranks platform (a client is a client regardless
   of host), so role sits before platform. The result is a
   most-significant → least → optional gradient.

The `vscode-languageclient` / `vscode-languageserver` counterexample
(platform-front) doesn't apply: there platform is *fixed*, so it's a
brand prefix, not a discriminating dimension. Here platform genuinely
varies and is sometimes absent — exactly the case where it must trail.

### Head-omission marks the cross-head member

Each role has a cross-head form (head slot dropped) and head-specific
forms. Dropping the head *is* the signal for "spans all heads":

| role | cross-head (head omitted) | head-specific | thin head folded in |
| --- | --- | --- | --- |
| **protocol** | `protocol` | none today (would be `glsp-protocol`, `data-protocol`) | data head at `protocol/data` |
| **server** | `core` | `glsp-server`, `data-server` | lsp head at `core/lsp` |
| **client** | `client-theia` | `glsp-client-theia`, `data-client-theia` | — |

Two rules fall out:

- **A head earns its own `<head>-<role>` package only when it's a
  substantial, separable owner.** A thin head stays folded into the
  cross-head package as a subpath: the LSP head lives at `core/lsp`
  (it's overrides on Langium-LSP, not an independent owner), the
  data-server contract lives at `protocol/data`. Split out (→
  `lsp-server`, `data-protocol`) only on real weight — `glsp-server` /
  `data-server` cleared that bar; LSP did not.
- **Name the cross-head package by whichever content dominates: role
  content → keep the bare role-name; foundation content → take a
  distinctive name.** `protocol` (wire contract dominates the utils /
  reconcile riding along) and `client-theia` (transport / forwarding *is*
  client-role content) keep their role-names. `core` is the *only*
  rename: the language/model runtime (Langium's `workspace` services,
  shared services, document builder) dwarfs the thin LSP head folded in,
  so foundation content dominates → a foundation-name. `server` would
  also miscategorize it — the `*-server` packages *are* servers (each
  owns a head over a transport); the cross-head package is the runtime
  they sit on, not a peer server.

**Decision (2026-06-01):** the cross-head client base, if/when the shared
Theia-host forwarder is lifted out of `glsp-client-theia` /
`data-client-theia`, is named **`client-theia`** — no qualifier
(`shared`, `base`, `common`). Bare head-omission, consistent with
`protocol`; the un-prefixed member *is* the base, the same way `core` is
among the `*-server` packages. (`common` would collide with the
intra-package `common/` folder; `shared` with `ServerSharedServices` /
`services.shared`.) Until that lift happens, each head keeps its own
sibling forwarder.

### Soft `core` / `lsp` boundary — inherited from Langium

`core` bundling the LSP head at `/lsp` mirrors Langium's own
`LangiumSharedServices`, which co-constructs a `workspace` group (the
model runtime — `DocumentBuilder`, `LangiumDocuments`, `WorkspaceManager`,
`IndexManager`) and an `lsp` group (`LanguageServer`, `Connection`) in one
object. The workspace runtime is usable headlessly (Langium CLIs drive
build/index with no `LanguageServer`), but the *default trigger* of
`WorkspaceManager.initializeWorkspace` lives in the lsp group
(`onInitialize` / `onInitialized`). So a head that needs the workspace
ready (GLSP, data-server) depends on a **`core` service**
(`HydraniumWorkspaceManager.workspaceInitialized`), NOT on the LSP
protocol head — the LSP head is merely the currently-wired *trigger* of a
core capability. `core` faithfully reflects Langium's bundling; the
soft boundary is contained inside it.

## Langium consumption — the `@hydranium/langium` chokepoint

The framework consumes Langium through one package, `@hydranium/langium`,
never the upstream `langium` (or `vscode-uri`) directly. It is an
**augmented re-export** (`export * from 'langium'`, ~99% passthrough, plus
`/lsp`, `/node`, `/test` subpath mirrors), modelled on `@eclipse-glsp/sprotty`
(which is itself an augmented re-export of sprotty) — and on Langium's own
re-export of `vscode-uri`'s `URI`. It is **not** a rebrand: Langium's names
are kept (`AstNode`, not `HAstNode`) because adopters legitimately think in
Langium AST. Curate, don't rebrand.

**Version governance — exact pin, framework owns the version.** `langium`
is declared as an **exact regular dependency**, NOT a `peerDependency` +
range. The version itself is not restated here — `packages/langium`'s own
manifest and the root `overrides` are where it is pinned, and a literal in
prose pins nothing while reading as though it does. This is the deliberate consequence of Hydranium
being a *foundational framework adopters build on* (World B), not a layer
added to a pre-existing Langium app — so Hydranium owns which Langium runs,
the way GLSP owns its sprotty version. Contrast the host-platform case:
host packages (`@theia/*` in the `*-client-theia` packages) use
`peerDependency` + bounded range, because the *application* owns the host
version. GLSP itself splits the same way and is the worked precedent: it pins its
re-exported sprotty model exactly, while its Theia integration takes `@theia/*`
as a bounded peer range. Read the two live figures out of
`node_modules/@eclipse-glsp/sprotty` and
`node_modules/@eclipse-glsp/theia-integration` rather than from here — a version
quoted in prose pins nothing and goes stale silently. The rule is what holds:
identity-critical re-exported model → exact regular dep; host platform → peer +
range.

**Single physical copy is the load-bearing invariant.** Re-export identity
transparency (`import { AstNode } from 'langium'` and `from '@hydranium/langium'`
resolve to the *same* class object) holds only given ONE physical install.
Guaranteed by a root `overrides`/`resolutions` pin of `langium` to the exact
version (mirrors the `vscode-jsonrpc` pin) — independent of import paths. An
adopter that declares its own `langium` must align to that version (or add a
root override at its own risk); the supported way to move Langium forward is
to bump `@hydranium/langium`, not to pin `langium` per-app.

**Enforcement is SOFT.** A `no-restricted-imports` lint rule bans direct
`langium` / `langium/*` / `vscode-uri` imports across this repo's
`packages/**` *and* `examples/**` (`packages/langium` itself and generated
code are exempt). Adopters in their own repos keep their `from 'langium'`
imports untouched — zero forced migration. Hard (GLSP-style blanket ban across adopters) is rejected: GLSP
needs it to enforce its `S*`→`G*` rebrand vocabulary; with no rebrand there
is no vocabulary to enforce, and adoption friction matters.

**Augmentation home.** Type/namespace augmentations of Langium live in
`@hydranium/langium/src/augmentations/` — currently the ambient `$synthetic`
`AstNode` type-merge and the `UriUtils` helper namespace. Use **module
merging** (`declare module 'langium'`) for cross-cutting type widenings, not
a re-exported own-`AstNode`: a widening like `$synthetic` must reach generated
subtypes and `$container` hops, which only an ambient merge achieves; a
same-name re-export shadow would create a parallel interface that generated
code (which imports `from 'langium'`) does not extend. Behaviour that *reads*
an augmentation (e.g. `markSynthetic` / `isSyntheticNode`) stays in `core`;
the chokepoint owns only the type/namespace widening, which propagates back
to consumers ambiently via the dependency.

## Chainable interface methods return `this`

Any method on an *interface* that derives a similar object — `Logger.for` /
`sub` / `with`, and the emit methods that yield their own receiver — is
declared to return `this`, never the interface name.

Declaring the interface widens over every implementation, and the widening is
invisible until a caller chains: `shared.Logger.for('X').withUri(uri)` fails to
compile because `for(...)` handed back the base interface and `withUri` lives on
the implementation. `this` typing carries the implementation type through the
chain instead, at no cost to implementers.

## Member visibility — `protected` over `private`

The framework defaults to **`protected`, not `private`, for class members**.
It is an extensibility framework: adopters subclass framework services to
customise behaviour, and every member they can't reach is a customisation they
can't make (and a seam tests can't exercise without a cast). So a member is
`private` only when narrower visibility protects a genuine invariant that a
subclass could corrupt — and that reason is worth a comment. Everything else —
instrumentation formatters, computation steps, config fields, internal helpers
— is `protected`, so subclasses (adopter and test) reach it directly.

Widening `private` → `protected` is non-breaking (it only adds reach), so err
toward `protected` when unsure; tighten later only with a documented reason.

## Comments — constraints, not examples

A comment earns its place by telling a reader something the code cannot:
**what breaks, what the code prevents, and which alternative was rejected at
what cost.** Everything else is either already in the code or will rot away
from it. The test to apply per hunk: *would a reader who has never seen this
repo need this to avoid breaking the code?* Keep it. *Does it only say what
happened to us?* Delete it.

The framework's doc comments are unusually load-bearing — adopters subclass
almost everything, so a class doc is the extension contract — which is exactly
why a wrong one is expensive. A sweep of every package in 2026-08 found roughly
sixty claims the code had outgrown; none was reachable by grep, and none had
ever gone red.

**Write:**

- The constraint. `dispose()` mutates the array, so snapshot before iterating.
  Stdout is the JSON-RPC channel, so every log level goes to stderr.
- The rejected alternative **with its cost**, in the present tense. "Gating on
  the shared version drops real edits in the lag window" — not "we used to gate
  on the shared version and it dropped edits".
- A technique for observing the system, when one is non-obvious. These read
  like trimmable prose and are the most valuable comments in the tree.

**Do not write:**

- **Illustrative examples.** No ` ```ts ` blocks, no worked invocations, no
  `e.g.` that restates the declared type. Keep an `e.g.` only when it names the
  single real case the code exists for. Examples belong in `examples/`, where
  they compile and cannot silently drift.
- **Pointers.** No work-item ids (a live one is still a pointer), no `docs/…`
  paths, no skill names, no sibling-file locators, no design-doc section
  numbers. A `{@link Foo}` to a symbol in the same package is not a pointer and
  is welcome — but make it resolve, or it renders as plain text and offers
  nothing.
- **Line numbers.** `L281`, `line 143`, `foo.ts:88`, "the guard above". They rot
  on the next edit with nothing to catch them; every one the sweep checked was
  already stale, several naming a different function than the one they claimed.
  Restate what lives there instead.

**What is gated, and what stays a reading job.** `check:link-tags` enforces
three of the shapes above inside a comment and nowhere else: a `foo.ts:88` file
reference, a work-item id at two digits or more, and a work-log basename
(`MIGRATION.md`, `open-work.md`, `completed-work.md`). It is deliberately
narrower than the rule it serves. A `line 143`, "the guard above" and a skill
name are not gated because no pattern separates them from legitimate prose —
`line 1` is ordinary language-server vocabulary and a skill name shares its
token space with the npm scope and the shipped binary. A `docs/…` path is not
gated either, and the one form to leave alone deliberately is a durable
concept or convention doc offered as further reading by a comment that already
stands alone; a `docs/…` path whose substance the reader needs is still a
pointer and still goes. Everything ungated is still the rule — a green gate is
not a swept file.
- **History.** Describe behaviour, not the session that produced it. No "used
  to", no "no longer", no dates, no branch names, no version stamps.
- **Inventories and counts.** "Adds two pieces of behaviour", "the four lookup
  paths", a list of the slots a module binds. This is the single shape that rots
  most reliably, because the list stops matching the moment anyone adds to the
  code and nothing points at the comment. Prefer a description that cannot go
  stale, or a `{@link}` to the declaration that holds the real list. **If a
  comment does arithmetic, do the arithmetic** — one explained a total as
  "14 files + …" while its own sibling assertion pinned 15.

**Bind the block to the declaration it describes.** TypeScript attaches the
*last* doc comment above a declaration, so a long class doc followed by a
second block silently documents the interface underneath while its real subject
gets nothing. It compiles, it lints, and it reads fine in a diff. Nine of these
were found in `packages/core` alone. The detector, worth running after any large
doc edit:

```
grep -rn -A1 '^\s*\*/$' --include='*.ts' <src> <test> | grep -E '^\S+-[0-9]+-\s*/\*\*'
```

Not every hit is a defect — a file-level block above a documented declaration is
legitimate — but every defect of this shape is in the list. It has three blind
spots, each of which hid a real one: a one-line `/** … */` above the pair leaves
no bare `*/` to match; a block separated from its declaration by a blank line
documents nothing and matches nothing; and there need not be a second `/**` at
all, when the block simply sits on the wrong declaration. Only reading finds the
last two.

**Test fixtures take neutral-abstract names**, never adopter domain vocabulary:
types `TypeOne` / `TypeTwo` / `SharedType` / `BaseType` / `UnknownType`,
elements `ns.Element` / `ns.Missing`, bare names `Element` / `Element1`, URIs
`file:///a.x` / `file:///x.other`, basenames `Element.a`, properties `ref` /
`members` / `name`, languageId `'plaintext'`. A framework test that reads like
one adopter's domain teaches the wrong thing about what the framework is for,
and the vocabulary drifts package by package once it starts.

Comments in `examples/` follow the opposite pull: that code exists to be read
and copied, so a worked example there is the point.

## User-facing messages

**The framework externalizes user-facing strings, never translates them, and
holds no locale.** Every user-facing string carries a stable code beside its
English text, and whoever owns the surface renders it. An adopter with their own
i18n reads the code; an adopter without one shows the English and never learns
any of this exists.

The absence of a locale in the framework is what makes it non-conflicting. If the
framework held one there would be two authorities, and the failure is concrete:
one toast carrying a German adopter sentence and an English framework clause.

### Which side resolves

The axis is **which process knows the reading user's locale**, not "does this
package know its host".

- **Resolve-side** — the Theia client packages' *frontend* code. Use the host's
  own mechanism directly (Theia `nls`), with the key **and** the English default
  as inline string literals at the call site. `theia nls-extract` is a textual
  extractor: an imported key or default throws a cross-file-reference error that
  the tool *suppresses*, so the call is silently dropped from the catalogue and
  nothing fails. Placeholders are positional (`{0}`), because Theia substitutes.
- **Identity-side** — `core`, `protocol` (including its portable client tier),
  `data-server`, `glsp-server`, and the `/node` half of a Theia package. Declare
  with `defineMessage` and attach the identity to what you already send. Never
  render. Placeholders are named (`{name}`), because our `interpolate`
  substitutes.

A Theia **backend** is identity-side even though it is a Theia package: `nls` is
a process global whose localization is assigned only in the browser preload, so a
backend holds one locale for every connected frontend, and in practice none.

### Codes

`hydranium/<unscoped-package>/<name>`, three `/`-separated segments, charset
`[a-z0-9-]`. The package segment locates the declaration, so a message is
declared in the package that raises it. `.` and `:` are forbidden — they are
i18next's default key and namespace separators, where either silently becomes a
nested lookup that misses. **No code may be a prefix of another**: a host
catalogue is nested JSON and errors outright on the collision.

Declarations live beside their call sites and are re-exported from the package's
`./messages` barrel, which is enumeration rather than centralization. The barrel
makes every code and English default public API, so renaming a code is a breaking
change. The English is a fallback; the code is the contract.

### Enumerating what exists

The two layers enumerate differently, and neither needs a generated file
committed:

- **Identity-side** — the `./messages` barrel *is* the enumeration, because a
  declaration is an exported constant carrying `.code` and `.text`. An adopter
  whose tooling wants JSON emits it themselves with `collectMessages(barrel)`.
- **Host-bound** — the keys are inline literals inside `nls.localize`, so the
  host's own tool is the only way to list them:

  ```
  npx theia nls-extract -o nls.json -r packages/client-theia/src -f '**/*.ts' -l nls-extract.log
  ```

  **`-l` is mandatory, not optional.** The extractor *suppresses* its own
  cross-file-reference errors, so a key built from an imported constant is
  dropped from the catalogue silently and the exit code stays 0 — verified: it
  emitted 33 keys instead of 34 and reported nothing. That log is the only
  channel the suppressed diagnostics reach, which is also why this is not a
  `check:` gate: a gate reading the exit status would certify an incomplete
  catalogue. Read the log. (A *same-file* constant does resolve, so the
  inline-literal convention is deliberately stricter than the tool requires.)

### Audience triage comes first

**A mechanism cannot fix a message that should not be shown.** Give a
developer-addressed string a code and you have built a *translated* leak. So the
first question is not "which carrier" but "who is this addressed to", and the
answers include **rewrite** and **leave it a plain `Error`** — neither of which
is a localization outcome. A message naming framework symbols, a DI slot or a
wire method is addressed to whoever composes the system, and stays a plain
`Error`.

### Out of scope by policy

Written once here so nobody re-audits them:

- **The CLI** — developer audience, argv and stdout, no host; and its usage shape
  is a grep contract for CI, which is a stronger reason than audience.
- **Diagnostic report formatters and logs** — developer-facing under a different
  externalization policy.
- **Backend-origin dialogs** — one string, English. Localizing one needs a
  frontend-facing RPC service, because the channel is a byte relay and its error
  emitter carries an `Error` rather than an identity. The lint rule is scoped off
  `src/node/` for exactly this reason.
- **GLSP diagram errors** — no slot exists anywhere in the action protocol, so
  English by upstream constraint. `MessageAction.details` is not a substitute: it
  is prose populated from `cause?.toString?.()`.
- **Product nouns are not i18n.** A framework product name leaking into an
  adopter's UI is a branding defect wanting a configurable name (`serverName`),
  not a catalogue entry — routing it through one would ask an adopter to
  "translate" English into their own product name.

### Fragments are not parameters

A prose fragment interpolated into a sentence becomes **one code per value**, not
one code with a parameter: the interpolated text is itself translatable, and a
fragment dropped into a sentence the framework does not own leaves no translator
in control of the whole. A **number** or a **technical error string** is safe as
a parameter for the opposite reason.

Where a message repeats a name the UI already owns — a command label quoted
inside an instruction — the fix is structural, not a second catalogue entry: hold
one field and offer the command as an action. A button labelled X that does X
cannot send anyone hunting, so name agreement stops being load-bearing instead of
being engineered.

## Test support

Every framework package that ships reusable test scaffolding exposes it
from a `*/testing` subpath (`@hydranium/core/testing`,
`@hydranium/data-server/testing`, …). Adopters discover the artifacts by
convention: one `make`-verb, three artifact categories, one harness
contract. The one exception is `startSpawnedServer`, which owns a CHILD
PROCESS: it is asynchronous and its factory can fail, so it takes the `start`
verb the production launchers use (`startLanguageServer`, `startSocketServer`)
rather than a `make` that would have to return a promise.

`*/testing` is **browser-neutral and gated as such**
(`scripts/check-neutral-bundles.mjs`), on the same rule the package surface
uses: the portable name is the short one. Scaffolding that needs a real
filesystem or a Node stream transport ships from `*/testing/node`
(`@hydranium/core/testing/node`, `@hydranium/protocol/testing/node`), so a
browser-hosted test tier can load the doubles without the harnesses. Three
`./testing`-family entries are excluded from the gate on their merits rather
than split: `@hydranium/data-server/testing` is a single harness over a duplex
connection, with no portable half to protect, and `@hydranium/conformance`'s
two per-runner adapter subpaths (`/vitest` and `/jest` — not `*/testing`
subpaths themselves) reach slices that assert with `node:assert/strict` by
design.

### Test runner — Vitest

The framework runs on **Vitest** (native ESM + TypeScript, built-in `bench` +
coverage). One root `vitest.shared.ts` exposes `definePackageVitestConfig('<name>')`;
each package's `vitest.config.ts` is a one-line call to it (the Vitest `name`
mirrors the old jest `displayName`). There is no ESM/CommonJS config split —
Vitest transforms via esbuild and runs in its own module runner, so the same base
serves both. Turbo still runs each package's `test` script, so the per-package
execution + caching model is unchanged.

A root `vitest.config.ts` globs the package and example configs under
`test.projects` — globbed rather than enumerated, so a package or example that
gains a suite is discoverable without editing that file.
The Vitest VS Code extension needs a root config to resolve a workspace (without
one it fails with "Cannot resolve entry module"). It is for the IDE / a bare
root `vitest` only; turbo never reads it, and a package's `vitest run` resolves
its own config (Vitest does not walk up), so per-package isolation holds.

- **Globals come from `'vitest'`**: `import { describe, it, test, expect, beforeEach, afterAll, … } from 'vitest'` — never `@jest/globals`.
- **Spies / mocks use `vi.*`**: `vi.fn`, `vi.spyOn`, `vi.mock`, `vi.useFakeTimers`, `vi.advanceTimersByTime`. The spy-handle TYPE is `MockInstance` (a named `'vitest'` import), NOT `jest.Spied`.
- **`typecheck:test` STAYS.** Vitest is transpile-only (it does not type-check), so each package's `test` is `npm run typecheck:test && vitest run` — the `tsc --noEmit -p tsconfig.test.json` gate is what actually type-checks the tests.
- **No fixed sleeps.** Await asynchrony with `waitFor` / `tick` (see "Awaiting in-process asynchrony" below), never a hand-rolled `setTimeout`/`settle()`.

**Testing a GLSP head under Vitest — CSS pre-bundle.** `@eclipse-glsp/client`'s
built CommonJS modules `require("….css")`. Vitest externalizes `node_modules`
(loads them through Node untransformed), so Node parses that CSS as JavaScript
and throws `Unexpected token '.'`. Neither `test.alias` nor `server.deps.inline`
reaches an externalized CJS `require`. The fix is to route the GLSP packages
through Vitest's dep optimizer and have the bundler empty their CSS imports —
paid once, then cached (net effect == jest's old `moduleNameMapper` CSS stub).
A package whose tests import `@eclipse-glsp/client` (e.g. `glsp-client-theia`)
`mergeConfig`s this onto the shared base:

<!-- snippet-skip: a vitest config object fragment, not a standalone module -->

```ts
test: {
   deps: {
      optimizer: {
         ssr: {
            enabled: true,
            include: ['@eclipse-glsp/client', '@eclipse-glsp/sprotty', 'sprotty'],
            // Vitest 4 bundles deps with Rolldown; `moduleTypes` empties the CSS.
            rolldownOptions: { moduleTypes: { '.css': 'empty' } }
         }
      }
   }
}
```

### One verb — `make`

Every factory is `makeXxx(...)`. There is no `create*`, `build*`, `new*`,
or class-export entry for test artifacts; `make` is the only construction
verb. (Doubles that must subclass a real production class keep the class
private and still expose a `makeXxx` factory — see `makeStubModelService`,
whose `StubModelService` is a `type` alias over a private impl.)

### Three categories + naming pattern

| category | naming | returns |
| --- | --- | --- |
| **double** (stand-in for one production service) | `makeStub<Service>()` | `Stub<Service>` |
| **harness** (wired bundle around a system-under-test) | `make<Subject>Harness()` | `<Subject>Harness` |
| **builder / primitive** (a fixture value or transport, not a service stub) | `make<Thing>()` | `<Thing>` |

- **Doubles** mirror a single production interface and record what was
  done to them: `makeStubProjectManager`, `makeStubLangiumDocuments`,
  `makeStubDocumentBuilder`, `makeStubWritableFileSystem`,
  `makeStubHydraniumTextDocuments`, `makeStubModelService`,
  `makeStubSelfSaveRegistry`, `makeStubAstDocumentManager`,
  `makeStubOutputChannelManager`, `makeStubInversifyContext`.
- **Harnesses** wire a subject through a seam and capture observations:
  `makeTestServices`, `makeDataServerHarness`, `makeGlspHarness`.
- **Builders / primitives** produce a fixture or a transport, not a
  service stand-in: `makeFakeAstNode`, `makeFakeDocument`,
  `makeFakeDescription`, `makeFakeReflection`, `makeNoopLogger` /
  `makeCapturingLogger`, `makeNoopTracer` / `makeCapturingTracer`,
  `makeDuplexConnectionPair`, `makeFakeClock`, `makeBindRecorder`.

### Builder shape — generic-typed-args factory, not a fluent builder

Fixture builders are plain factories taking an options/args object — NOT
fluent/chained builders. Compose them by shallow nesting
(`makeFakeDocument(uri, makeFakeAstNode<Foo>({ … }))`); name an intermediate
`const` when the value is reused, asserted on, or when building a tree with
`$container` back-references (nesting can't express the parent↔child cycle).

- **Generic iff the return shape is caller-chosen.** `makeFakeAstNode<T>({ … })`
  takes a type argument because `AstNode` has grammar-generated subtypes only the
  caller can name — the single unavoidable `as unknown as T` (an object literal
  can't satisfy a generated nominal interface) is encapsulated in the factory so
  call sites stay cast-free. Builders that return ONE fixed framework type
  (`makeFakeDescription` → `AstNodeDescription`, `makeFakeReflection` →
  `AstReflection`) take an options bag and need no type argument.
- **Fluent builders are reserved for wired, stateful subjects** — that is the
  *harness* tier (`makeTestServices` / `make<Subject>Harness` returning a bundle
  with `dispose()`), not leaf value fixtures.
- **Don't re-declare local fixture builders.** A `no-restricted-syntax` lint
  rule (see `eslint.config.js`) bans re-introducing a local `fakeNode` /
  `makeNode` / `fakeReflection` / `makeDescription` — or a local shadow of the
  logger/tracer/services helpers `makeNoopLogger` / `makeCapturingLogger` /
  `makeNoopTracer` / `makeCapturingTracer` / `makeNoopSharedServices` /
  `makeNoopLanguageServices` (or the GLSP `makeNoopGlspLogger` /
  `makeCapturingGlspLogger`) — in `test/**`. Import the shared builder from
  `@hydranium/core/testing` (or `@hydranium/glsp-server/testing`) instead. This
  is what keeps the fixtures from
  drifting back into per-file copies. (A local helper that *composes* a shared
  builder for a suite's recurring shape — e.g. `makeIntegrityServices` wrapping
  `makeNoopLanguageServices` — is fine: a differently-named specialisation, not
  a re-declaration.)
- **A residual cast in a test signals intent, not a gap.** After a fixture goes
  through a builder, a surviving `as unknown as X` should mean the fixture is
  *deliberately* minimal/degenerate (the code under test reads only one field,
  or a value must be `undefined`) — the minimal literal documents that better
  than a fully-populated fake would.
- **Cast-level bans grow per-type and per-form, only once clean.** The same
  `no-restricted-syntax` rule also bans casting an object literal to a fixture
  type — but only for the cast *form* whose `test/**` count has already reached
  zero, so the ban never fights a legitimate minimal cast. `AstNodeDescription`,
  `Logger`, `ServerSharedServicesMinimal`, and `GlspLogger` are banned in both
  forms: every description routes through `makeFakeDescription`, every logger stub
  through `makeNoopLogger` / `makeCapturingLogger` (or `vi.spyOn` on a real logger,
  or `makeNoopTracer` / `makeCapturingTracer` for the `Tracer` slot), every
  partial shared-services tree through `makeNoopSharedServices` (whose overrides
  are loosely typed so a structurally-narrower stub slots in without a per-slot
  cast), and every GLSP logger through `makeNoopGlspLogger` /
  `makeCapturingGlspLogger`, so any such `x as T` signals drift. `AstNode` is
  banned only in the **double-cast** form
  (`x as unknown as AstNode`, now zero after every object-literal fixture moved
  to `makeFakeAstNode`); bare `{} as AstNode` (no `$type`, degenerate — the code
  reads one field) stays allowed. `LangiumDocument` / `AstReflection` still carry
  legitimate minimal casts (a stub reads one field, or implements reflection
  methods the builder does not model — `makeFakeDocument` also builds a *fuller*
  shell than a bare `{ uri }` stub wants), so they stay allowed until their
  counts drop. An intersection cast (`x as AstNodeDescription & { … }`) is a
  structural extension, not a fixture, and is not matched.

### The uniform harness contract

A harness is a wired bundle around a system-under-test, driven through a
seam. Its shape is uniform:

<!-- snippet-skip: `<Subject>` metasyntax placeholders, not TypeScript -->

```ts
interface <Subject>Harness extends Harness {
   readonly <subject>;   // the system-under-test
   readonly <seam>;      // the handle tests drive it through
   readonly …captures;   // append-only observation arrays
   dispose(): void;      // idempotent teardown — the one universal member
}
```

Every harness interface `extends Harness` from
`@hydranium/protocol/testing`, whose sole member is `dispose(): void`. That
marker pins the one identical member across all harnesses, so teardown is
always `harness.dispose()` regardless of which harness, and a `Harness`
reference can release any of them without knowing its concrete type.
`dispose()` is idempotent. Concrete mappings:

| harness | subject | seam | captures |
| --- | --- | --- | --- |
| `TestServicesBundle` (`makeTestServices`) | `services` | the `Stub*` members | stub-internal records; `dispose()` is a no-op (state is in-memory) |
| `DataServerHarness` (`makeDataServerHarness`) | `server` | `proxy` / `pair` | `events`, `saves`, `projectsChanges` |
| `GlspHarness` (`makeGlspHarness`) | `state` | `server` + `dispatch` / `nextAction` (and `container` / `sessionContainer`) | `actions` (outbound actions, in arrival order) |

### Options idiom

Prefer a single options object — `make<Subject>Harness({ … })`,
`makeTestServices({ seedDocuments, seedProjects, serialize, … })` — so call
sites name what they pass and growth is non-breaking. Current state: a few
single-dependency stubs still take a positional argument mirroring their
constructor (e.g. `makeStubWritableFileSystem(selfSaveRegistry?)`,
`makeStubModelService(services, serialize)`). These are kept positional
because the one (or two) arguments are the constructor's own; new optional
inputs are added as an options object rather than further positionals.

### Per-package exports

| package | subpath | offers |
| --- | --- | --- |
| `protocol` | `@hydranium/protocol/testing` | the browser-neutral shared primitives: `makeFakeClock` (deterministic `Clock` double on one virtual time axis — `advance(ms)` drives `now()`, live stopwatches, and due timers), the `Harness` marker interface, and the async-await helpers `waitFor` / `tick` (see "Awaiting in-process asynchrony" below) |
| `protocol` | `@hydranium/protocol/testing/node` | `makeDuplexConnectionPair` (in-process duplex `MessageConnection` pair) + `DuplexConnectionPair`, and the `makeDuplexStreamPair` substrate under it. Node-only because a `PassThrough` is in the exported type and the stream readers come from `vscode-jsonrpc/node` |
| `core` | `@hydranium/core/testing` | Langium-layer doubles (`makeStubLangiumDocuments`, `makeStubDocumentBuilder`, `makeStubHydraniumTextDocuments`, `makeStubAstDocumentManager`, `makeStubWritableFileSystem`, `makeStubSelfSaveRegistry`, `makeStubProjectManager`, `makeStubModelService`, `makeStubServiceRegistry`, `makeStubIndexManager`); the `makeTestServices` harness composing them into a `ServerSharedServices` tree, alongside the leaner `makeNoopSharedServices` / `makeNoopLanguageServices`; the fake builders `makeFakeDocument` / `makeFakeDescription` / `makeFakeReflection`; the logging and tracing doubles from `make-test-tracer` (`makeNoopLogger` / `makeCapturingLogger` / `makeNoopTracer` / `makeCapturingTracer`); the `makeAstSnapshot` and `documentUriPolicyConformance` primitives; and a verbatim re-export of `langium/test` for grammar-driven tests |
| `core` | `@hydranium/core/testing/playwright` | the Playwright-only e2e helpers, in a dedicated subpath so a unit-test import never pulls in the optional `@playwright/test` peer: `e2e-profiling`, the `browser-capture-bridge`, and the server-log capture / fixture / rename-reporter modules |
| `core` | `@hydranium/core/testing/node` | `makeLspHarness` (an LSP head over an in-process connection) and the `makeLspServerConnection` transport under it; `startSpawnedServer` (the subprocess tier — a BUILT entry run as a child process over real pipes, with the diagnostics / `window/logMessage` / stderr captures, a polled `port(command)` lookup and a `SIGKILL`-backed teardown); `makeScratchWorkspace` (a disposable on-disk workspace), `makeGeneratedWorkspace` (a seeded, byte-reproducible scaled corpus) and `makeGoldenCorpus` (committed fixtures read from a directory). Node-only: each names a capability a browser lacks — a `vscode-languageserver/node` `Connection`, a stream transport, a child process, the real filesystem |
| `data-server` | `@hydranium/data-server/testing` | `makeDataServerHarness` (DataServer + local client + typed RPC proxy over an in-process duplex pair); re-exports the `DuplexConnectionPair` **type** from `protocol/testing/node`, because `DataServerHarness.pair` names it in a public signature — the `makeDuplexConnectionPair` factory is reached from `protocol/testing/node` itself. Node-bound throughout, so it is not gated for neutrality |
| `glsp-server` | `@hydranium/glsp-server/testing` | `makeGlspHarness` (a real `GLSPServer` driven in-process — dispatch a GLSP action, capture the response over a stub `GLSPClientProxy`), plus the GLSP-logger doubles `makeNoopGlspLogger` / `makeCapturingGlspLogger` |
| `glsp-client-theia` | `@hydranium/glsp-client-theia/testing` | `makeBindRecorder`, the GLSP-module-specific Inversify double. The cross-head doubles (`makeStubInversifyContext`, `makeStubOutputChannelManager`) are reached from `@hydranium/client-theia/testing` |

The CLI's `src/testing/echo-server.ts` is a spawnable stdio fixture, not a
reusable export, so the `cli` package ships no `testing` barrel.

### Multi-language tests — never hand-roll a `ServiceRegistry`

Any test whose subject routes per URI (the data head's reference router, the
build pipeline's group-by-language dispatch, the GLSP index) needs a populated
`ServiceRegistry`. Get one from `makeStubServiceRegistry(languages)`, or from
`makeTestServices({ languages })` for a full shared tree:

```ts
const bundle = makeTestServices({
   languages: [
      { languageId: 'fake', fileExtensions: ['.fake'], producedTypes: ['Entity'] },
      { languageId: 'other', fileExtensions: ['.other'], producedTypes: ['Mapping'] }
   ]
});
```

**The registry it returns is real** — the framework's own
`ExtendedServiceRegistry`, carrying stub *languages*. So `getServices` walks
Langium's actual ladder (declared languageId → file name → extension), misses
throw Langium's actual error, and `hasServices` / `getServicesById` /
`getServicesByExtension` come for free. A hand-rolled `{ getServices: uri =>
uri.endsWith('.b') ? … : … }` re-implements that ladder, and a
re-implementation drifts: it is the fixture-vs-reality gap that let two
multi-grammar defects pass a green suite.

Two consequences worth knowing before migrating a fixture:

- **URIs must be real `URI`s.** The registry parses the extension off the URI
  rather than reading its string form, so a `{ toString }` shell no longer
  routes.
- **`producedTypes` synthesises a minimal `Grammar`**, which is what feeds
  `collectProducibleTypes` and therefore type→language routing. List a type
  under two languages to exercise the several-owners (abstain) case.

`makeTestServices` binds no `ServiceRegistry` at all unless `languages` is
passed — production paths that optional-chain the slot must keep seeing it
absent.

### Exposure rules — no root hub

- Each package exposes its scaffolding from its own `*/testing` subpath.
  There is deliberately **no** `@hydranium/testing` root hub: a single
  aggregate would become a dependency hub — an adopter testing only the
  data-server would drag in GLSP / Inversify and risk import cycles.
- The only artifacts that live above a single package are the
  **server-free** shared primitives — the `Harness` interface, `makeFakeClock`
  and `waitFor` / `tick` in `@hydranium/protocol/testing`, plus
  `makeDuplexConnectionPair` one subpath down in
  `@hydranium/protocol/testing/node` — which sit in `protocol` because every
  harness package already depends on it, so they add no new cross-package
  coupling. The duplex pair is split out because a `PassThrough` is in its
  exported type, and leaving it in the neutral barrel tainted every subpath that
  re-exported it.
- `*/testing` is kept out of each package's main barrel so production
  bundles never pull in the test scaffolding; adopters opt in by importing
  from the explicit subpath.

### Awaiting in-process asynchrony — `waitFor` vs `tick`

In-process tests routinely wait for an asynchronous effect (an RPC notification
crossing the duplex wire, a `DocumentBuilder` phase event). Do NOT hand-roll a
fixed `setTimeout` sleep — it is simultaneously too slow on the happy path and
flaky under parallel CI/turbo CPU oversubscription (a starved event loop can
blow past a test timeout). Use the two `@hydranium/protocol/testing` helpers:

- **`waitFor(predicate, opts?)`** — the default. For any assertion that an effect
  **will** happen ("eventually N events", "a build ran", "the doc reached a
  phase"). Polls the predicate, resolves the instant it is true (so it is faster
  than a sleep) and tolerates a slow loop up to `timeoutMs` (so it does not
  flake). Example: `await waitFor(() => harness.events.length === 1)`.
- **`tick(ms = 10)`** — the exception. A bounded event-loop yield, for when there
  is no pollable positive condition: an assertion that an effect **did not /
  has not yet** happened (a negative cannot be polled), or a setup/ordering yield
  (let a queued call register before resolving its connection). Example:
  `await tick(); expect(events).toHaveLength(0)`.

A microtask flush (`await Promise.resolve()` / `queue-microtask`) is never a
substitute: stream-delivered JSON-RPC notifications arrive on a macrotask/IO
turn, after microtasks drain.

### The conformance kit — the one standalone test package

`@hydranium/conformance` is the deliberate **exception** to "test support
lives in a `*/testing` subpath, not its own package." It is not per-package
scaffolding — it is an adopter-imported, protocol-only contract suite (a TCK)
an adopter runs **against their own server** to prove they speak each protocol
correctly. It therefore ships as a standalone package with subpath-per-head
slices (`@hydranium/conformance/data` / `/lsp` / `/glsp`) and the same no-root-hub
rule (no barrel re-exports the slices, so importing one head never drags in
another's protocol types). Each slice takes the adopter's live server through a
**driver port** the existing harnesses satisfy structurally, and depends only on
`@hydranium/protocol` — no concrete server package, no upstream wire libs.

**Runner-agnostic.** The kit core names NO test runner. Check bodies assert with
`node:assert/strict` (they throw on failure — works under any runner), and the
core exports the pure `build{Data,Lsp,Glsp}Checks()` lists plus
`emitConformanceSuite(runner, suite, checks)`, which drives an injected
`ConformanceRunner` port (`describe` / `test` / `skip` / `afterAll`) rather than
calling a runner directly. Two thin **per-runner adapter subpaths** bind that
port, structurally identical and differing only in the runner they import and
the const they bind: `@hydranium/conformance/vitest` (binds `'vitest'`) and
`@hydranium/conformance/jest` (binds `@jest/globals`). Both `vitest` and
`@jest/globals` are *optional* peers, so an adopter installs only the one for its
runner. Each exposes `run{Data,Lsp,Glsp}Conformance` + the slice types. This
insulates an adopter's runner (one shipping adopter is on Jest) from the framework's runner
choice. Precedent: `abstract-level`'s TCK injects the runner the same way.

The framework's own dogfoods run on `/vitest` (the framework is on Vitest). To
keep the `/jest` adapter from rotting once nothing else exercises it, the
conformance package keeps ONE Jest-run smoke (`test/jest/`, run by a
self-contained `jest.config.cjs` that Vitest's config excludes) that drives the
shipped `/jest` subpath under a real Jest process — the only Jest left in the
repo.
