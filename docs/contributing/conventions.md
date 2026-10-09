# Framework conventions

The rules `@hydranium/*` code follows, and why. A rule a gate enforces is one
line naming the gate; the detail lives in the rule file or script. The rest is
held in review.

## Package structure

**Every package declares an `exports` map with one bare key per artefact and
no wildcard target**, because a second key is a second semver name that can
drift and a missing map makes every compiled module public; enforced by
`check:exports` (`scripts/check-exports-map.mts`), which also requires an asset
target to exist and ship through `files`. Keys point into `lib/`, never `src/`,
so adopters cannot depend on internal layout; a new subtree gets an `index.ts`
and its own key.

### The `./node` boundary

**`.` is strictly neutral, `./node` is server-only, and `./browser` exists only
where DOM code does.** The oxlint `no-restricted-imports` rule bans `node:*` in
neutral `src/` (`src/node/` and `src/testing/` exempt); the oxlint
`no-restricted-globals` rule bans raw `process` / `Buffer`, which go through
the accessors in `core/src/util/environment.ts`; `check:neutral`
(`scripts/check-neutral-bundles.mts`) bundles each gated entry for the browser
to catch a transitive `node:` import; DOM globals are banned by
`lib: ["ES2022"]` only in packages that inherit it.

The polarity is Langium's (a neutral root with named platform exceptions), not
GLSP's always-three `/common` + `/browser` + `/node`, because neutral code
dominates an LSP framework. Keep the root strictly neutral, not merely
browser-safe: DOM code there breaks a DOM-less worker or a plain Node consumer.
A portable module needing a Node capability takes it through a seam `./node`
fills, never a static `node:` import. Why the split exists:
[Browser hosting](design/browser-hosting.md).

### A host-integration package's root barrel follows its upstream

The neutral-root rule binds the four head-neutral packages. **A
`packages/*-theia` root barrel matches the root convention of the upstream it
integrates**, judged by what an adopter importing the bare specifier is
entitled to get: re-export the browser tier where the upstream's root is its
browser tier, and declare nothing (`export {}`) where the upstream has no root
surface. A module belongs on `common/` only when its whole dependency closure,
type-only imports included, is neutral or Theia's common tier; create the tier
when a module needs it. A root re-exporting a browser tier loads only in a
frontend build, so its declaration comment must not call it neutral.

### Package naming

Names follow `<head>-<role>-<platform>`; the tooling packages (`cli`,
`conformance`, `langium`) take a bare name. `<role>` is `protocol`, `server` or
`client`, where "client" means the protocol's client side, so a
`*-client-theia` package spans `browser/` and `node/`. `<platform>` trails
because it is optional, so a head's packages sort together. **Omitting the
head marks the cross-head member** (`protocol`, `core`, `client-theia`), with no
`shared` / `base` / `common` qualifier to collide with `services.shared` or a
`common/` folder. A thin head stays a subpath (`core/lsp`, `protocol/data`)
until it is a separable owner. `core` alone takes a foundation name, because
the Langium runtime it carries dwarfs the LSP head folded in; a head that needs
the workspace ready therefore depends on a `core` service, not the LSP head.

### The `@hydranium/langium` chokepoint

**Framework and example code imports Langium and `vscode-uri` through
`@hydranium/langium`**, because `langium` moves in lockstep with the
`vscode-languageserver` chain and the chokepoint lets the framework own that
pin; enforced by the oxlint `no-restricted-imports` rule over `packages/**` and
`examples/**`, with `packages/langium` and generated code exempt. It curates
and does not rebrand: adopters think in Langium AST.

`langium` is an exact regular dependency, not a peer range, because the
framework owns which Langium runs; a host platform (`@theia/*`) is a peer range
because the application owns it. **One physical copy is the invariant** behind
the re-exports: the root `overrides` pin holds it, and `assertSingleLangiumCopy`
rejects a reflection built on a second copy at bootstrap. Type augmentations
live in `packages/langium` as module merging (`declare module 'langium'`),
because only an ambient merge reaches generated subtypes.

## Code shape

**Formatters.** A helper formatting an entity for a log line or error is a
`format*` method on the class that emits it, `protected` unless another package
reads it, so an adopter enriches it by overriding with `this` in reach.
Stateless shared primitives stay on the `Format` namespace.

**Configurable options.** An option an adopter might bind to a user setting
takes a `MaybeObservableValue<T>`, normalised once with `ObservableValue.from`
into its own field and read through `.value` at use. Widen only an option that
maps to a JSON-primitive setting **and** is read at use: one read once into a
long-lived resource (a timer period, a port) stays plain `T`, or it advertises
a liveness it cannot honour. `Settings.*` reads the section named by
`lsp.configurationRoot`, whose default picks the first registered language and
warns when there are several; a multi-grammar adopter passes `root` or rebinds
the slot.

**Constructor shape.** A class bound in a module takes
`(services, options = {})`: `services` as the narrowest slice its reads need,
nothing passed separately that `services` reaches, and options before they
have a field. It matches Langium's constructors, and adding an option never
breaks a caller. An unbound class (a value object, a collaborator built through
a protected `create…`) takes its data directly.

**`LogNameOptions`.** A bound service whose `services` reach the framework
`Tracer` extends its options from `LogNameOptions`, holds a `Tracer`, and emits
one instantiation trace under `options.logName` or a fallback: a fixed label
for a single canonical implementation, `this.constructor.name` where the slot
has swappable strategies, so the log shows which ran. GLSP states are built per
request by Inversify and inject `HydraniumTypes.Tracer` instead.

**Typeguards and namespaces.** A typeguard the framework defines is a free
function, `isFoo(x): x is Foo`, matching the generated guards adopters call. A
namespace merged with a type holds factories, utilities and constants, never a
guard. Upstream types are guarded in upstream style
(`ChangeBoundsOperation.is`). Prefer a guard to a structural cast, which
asserts a shape nobody checks; nothing lints this.

**`as*` casts, `to*` converts.** `asFoo(x)` returns its argument unchanged
under another type, a brand or a mutable view (`asCanonicalUri`, `asMutable`),
and checks nothing; `toFoo(x)` computes a new value of another type
(`toLanguageClientUri`, `toTransfer`). A reader can then tell from the name
whether a call does work or only asserts a type nobody checked.

**`Client` is any client; `LanguageClient` is the LSP textual one.** A member
name that says `Client` takes a `clientId` or spans every client
(`isOpenInAnyClient`, `onClientClosed`); one specific to the LSP textual
client, its shadow, its `applyEdit` channel or its URI space, says
`LanguageClient` (`isOpenInLanguageClient`, `setLanguageClientText`), so a
reader never has to guess which client a bare `Client` means.

**`*Protocol`** names a typed multi-method interface the framework owns that
lowers method by method to JSON-RPC, which is the data head's. Fragments carry
the role (`DocumentServerProtocol`, `DocumentClientProtocol`), compositions
extend them, and implementations and in-process services stay bare. Each
fragment pairs with an `as const satisfies` method-name list so the two cannot
drift. A single command, GLSP's actions and LSP itself carry no suffix: the
discriminator is shape, not transport.

**Class role names.** `Abstract*` only with unimplemented abstract members;
complete behaviour makes a class concrete. `Default*` is the concrete default
of a bare-named framework interface, including a collaborator built through a
protected `create…`, which is called on first use through a getter because a
subclass's fields do not exist during the constructor. `Hydranium*`
specialises an upstream class without colliding with its `Default*`; the GLSP
packages use `HydraniumGlsp*` for their own concepts. Values, errors, utilities,
forwarders and multi-implementation families take bare descriptive names.

**Slots are interfaces.** A DI slot is typed by a bare-named interface; the
`Default*` class appears only at the binding, a `base:` entry and an
`instanceof`. A class type carries its `protected` members into assignability,
compared by declaration, so a subclass of a class from a second installed copy
cannot fill the slot. Interfaces also let `WithServiceOverrides` replace a
framework declaration, where an intersection keeps both as an order-dependent
overload set. An empty interface is legitimate when the whole surface is
`protected`; its oxlint `no-empty-object-type` disable carries the reason. Type
parameters go where they are honest: per-URI members, not a cross-grammar slot.

**GLSP DI tokens** live in the `HydraniumTypes` registry, so a token's name
cannot collide with the type it injects. No language or per-language service
gets a token: a diagram's language is its document's, and
`modelState.<role>For(node)` keeps nodes from other documents on their own
grammar.

**Chainable interface methods return `this`**, because returning the interface
drops the implementation type and the next call in the chain fails to compile.

**`protected` over `private`.** Adopters subclass framework services, so every
unreachable member is a customisation they cannot make. `private` needs an
invariant a subclass could corrupt, stated in a comment. A type a `protected`
signature names must be exported, or an override has to restate it; enforced
by `check:protected-signatures`.

**Override points hold policy or wiring, not both.** Policy decides; wiring
carries it out (subscription, both error arms, ordering against `super`,
teardown). An adopter overriding a mixed method for its policy must copy the
wiring, and the copy silently diverges when the contract tightens. Ask what an
override changing one thing must reimplement; if anything, split. Where a split
is awkward, name the protected invariant at the declaration.

## Comments and documentation

A comment states what the code cannot: **the constraint, what breaks, and the
rejected alternative with its cost**, in the present tense. Adopters subclass
almost everything, so a class doc is the extension contract and a wrong one is
expensive. Do not write illustrative examples (they belong in `examples/`,
where they compile), pointers to work items, docs pages, files or line numbers,
history, or counts and inventories that go stale on the next addition.
`check:link-tags` gates file references, work-item ids and docs pages in
comments; a green gate is still not a swept file. TypeScript attaches only the
last doc block above a declaration, so a second block silently documents the
wrong thing. Test fixtures take neutral-abstract names (`TypeOne`, `Element`,
`file:///a.x`), never one domain's vocabulary.

A page describes the framework as it is. One home per fact, linked from the
rest. Versions appear only in
[`docs/adopting/requirements.md`](../adopting/requirements.md); elsewhere name
the manifest field. Name a default's constant or option, never its value.
Measurements belong in [`perf-baseline.md`](perf-baseline.md). No history: the
story belongs in the commit. Every page is reachable from `README.md` or
`docs/README.md`, except an agent skill under `.claude/skills/`, which the tool
finds; a skill vendored through `skills-lock.json` is someone else's text and
exempt. `check:docs` fails a dead link or anchor and holds unreachable pages
and these rot patterns to `scripts/check-docs-baseline.json`, which may only
fall.

**Every page has one audience.** The root README is for evaluators: what
Hydranium is, the demo, and the two ways on. Adopter pages
(`docs/ADOPTING.md`, `docs/adopting/`, `docs/concepts/`, `docs/guides/`) are
for people building a language on the framework; developer pages
(`docs/CONTRIBUTING.md`, `docs/contributing/`) are for people changing it. A
fact an adopter needs never lives only on a developer page.

**Adopter pages talk to the reader**: "you", what the reader does or sees
first, then how the framework does it, only as far as the reader needs. A
guide is numbered steps that end in how the reader knows it worked. **A detail
stays only if an example or the `init` scaffold uses it, or an adopter cannot
succeed without it**; the rest is TSDoc's or `--help`'s.

**Design pages state contracts**: invariants, their reasons and their
trade-offs, in the present tense. **No page restates code**: no lists of
members, options or errors, no signatures, no traces that follow the source.
Delete such material rather than move it. A table stays only when the reader
acts on every row.

**A package README follows the template** (what it gives you, install with
the peer table, wiring where the adopter binds something, entry points by
role, status, licence) **and links only the repository, `docs/ADOPTING.md`,
`docs/CONTRIBUTING.md` and `NOTICE.md`, as absolute URLs**, because npm keeps
each version's page as it shipped; name a guide in text rather than link it.
`check:readmes` holds the sections and the links. **An example README maps
each concern to its files** and links the guide rather than repeating it.

**Prose is wrapped at 80 columns**; only a line that is one link, code span or
word may run longer. `check:docs` fails the rest, since oxfmt does not format
Markdown.

## User-facing messages

**The framework externalizes user-facing strings, ships no catalogue and
selects no locale.** Every user-facing string carries a stable code beside its
English, and the adopter binds a renderer or shows the English
([Translate your language](../guides/translate-your-language.md)). **Exactly
one side renders a message: the one that knows the reading user's locale**,
which comes from that user's own client.

- **Server-side** (`core`, `data-server`, `glsp-server`): declare with
  `defineMessage`, attach the identity to what is already sent, and let the
  bound `MessageRenderer` render it. Placeholders are named.
- **Host-side** (the Theia client packages' frontend): Theia `nls`, key and
  English as inline literals, because `theia nls-extract` silently drops a key
  it cannot resolve; enforced by the ast-grep rules
  `unlocalized-message-service-text` and `unlocalized-command-label`.
  Placeholders are positional. A Theia backend renders nothing, since `nls` is
  localized only in the browser.
- **Client-tier**: renders only its own messages, which fire when no server
  could have worded them.

**Codes** are `hydranium/<unscoped-package>/<name>` over `[a-z0-9-]`, declared
where raised and re-exported from the package's `./messages` barrel, so renaming
one is a breaking change. `.` and `:` are forbidden as i18next separators. **No
code may be a prefix of another**, because a catalogue is nested JSON; enforced
for host keys by `check:nls-extract`.

**Audience triage comes first**, because a code on a developer string is a
translated leak. (a) For a user: a `defineMessage` code. (b) For a developer,
where a caller must react: a typed error with a class, an `is*` guard and a
code from `HYDRANIUM_ERROR_CODES`, whose reserved block adopters keep out of
because a guard matches the code alone after an RPC. (c) For a developer, with
nothing reacting: a plain or named `Error`. A message naming a symbol, slot or
wire method is (b) or (c), unless moving the identifier into `data` makes it
(a). (a) and (b) combine where a context-free end-user sentence exists. When
unsure, leave the identity out; one can be added later without a break.

**An override seam is not a localization carrier**: rewording for one product
is not translating for each reader, so render through `nls.localize` inside the
overridable method. Out of scope by policy: the CLI, report formatters and
logs, backend-origin dialogs, a `GLSPServerError`'s `cause` (developer content,
though Theia shows it behind "Show details"), and product names, which want a
configurable name.

### Diagnostics are rendered once, before they are published

`HydraniumDocumentBuilder` renders every diagnostic at `Validated`, before
Langium publishes, so every head receives the same sentence and an adopter
binds one slot; it is also the only placement that covers lexer and parser
errors. The framework claims Langium's and chevrotain's linker, lexer and
parser sentences under `hydranium/core/*` codes, attached only when the text is
byte-identical, so a reworded or custom diagnostic keeps its prose. "Every"
holds for serialised builds: under `ModelServiceOptions.allowReentrantBuilds` a
concurrent build can append diagnostics the pass never saw. Read a delivered
identity through `TransferDiagnostic.resolved`; `code` alone is shared with
Langium.

A renderer never re-renders a server-rendered message, matches structured
fields (`Diagnostic.data.code`) rather than English, and never throws, or the
document strands at `Validated` with nothing published; the guard sits on
`MessageRenderer`'s public methods, so overriding `translationsFor` inherits it.

### Fragments are not parameters

An interpolated prose fragment becomes one code per value, because the
fragment is itself translatable and no translator would control the whole
sentence; a number or a technical error string is a safe parameter. Where a
message would quote a name the UI owns, such as a command label, offer the
command as an action instead.

## Test support

Commands, the runner and timeouts are in [Testing](testing.md).

- **Scaffolding lives in `src/testing/` and ships from `./testing`**; tests
  live in `test/`, and production code never imports it. There is no
  `@hydranium/testing` hub, which would drag every head into every test; only
  the server-free primitives (`Harness`, `makeFakeClock`, `waitFor` / `tick`)
  sit above one package, in `@hydranium/protocol/testing`.
- **`*/testing` is browser-neutral**, gated by `check:neutral`, whose script
  names each exclusion beside its reason. Scaffolding needing a filesystem, a
  stream transport or a child process ships from `*/testing/node`.
- **One construction verb, `make`**: `makeStub<Service>()`,
  `make<Subject>Harness()`, `make<Thing>()`. `startSpawnedServer` owns a child
  process and can fail, so it takes the launchers' `start` verb.
- **Fixture builders are plain factories over an options object**, generic only
  when the caller picks the return type, so the one cast lives inside. Import
  the shared builder rather than re-declaring it (ast-grep
  `test-fixture-builder-function` / `test-fixture-builder-variable`), and don't
  cast an object literal to a type a builder covers (`test-fixture-cast-*`); a
  type joins those rules once no test needs a minimal cast of it.
- **Every harness extends `Harness`**, whose one member is an idempotent
  `dispose()`, so teardown is uniform. Prefer one options object to
  positional arguments, so growth is non-breaking.
- **A multi-language test gets a real `ServiceRegistry`** from
  `makeStubServiceRegistry` or `makeTestServices({ languages })`, never a
  hand-rolled one, so routing follows Langium's rules; URIs must be real `URI`s.
- **No fixed sleeps.** `waitFor` for an effect that will happen; `tick` only to
  assert one has not, or to yield for ordering. A microtask flush is no
  substitute: stream-delivered notifications arrive on a later turn.
- **`typecheck:test` type-checks tests**, because Vitest only transpiles.
- **`@hydranium/conformance` is the one standalone test package**: a per-head
  contract suite adopters run against their own server. Its core names no
  runner; per-runner adapter subpaths bind one.
