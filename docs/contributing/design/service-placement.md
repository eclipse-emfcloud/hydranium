# Service placement and composition

Why the framework's services sit on the tier they do, and why composition has
no framework layer over Langium's. The adopter's rules, the shared and
per-language tiers and the composition order, are in
[Customizing services](../../concepts/customizing-services.md); this page holds
the reasoning behind them.

## The factories are the enumeration

`createServerSharedModule` (`core/src/langium/module.ts`, typed by
`ServerAddedSharedServices`) and `createServerLanguageModule`
(`core/src/langium/language-module.ts`, typed by `ServerAddedServices`) each
return one `Module` literal, grouped as the services tree is, with a comment
on every default whose choice is not self-evident. No page lists the slots: a
list falls behind the factory while still reading as complete, and a reader
consults it _instead of_ the code. Read a factory against the placement rule:
every shared slot is something there must be exactly one of across every
language and every head, and every per-language slot is behaviour a second
grammar would need its own instance of.

## Placements the code cannot argue for

Each of these is a choice between two defensible answers:

- **`Clock` and `Logger` are top-level slots, not members of `client`.** Both
  are reached from paths with no client at all, such as headless CLI runs, so
  grouping them under a client namespace would make those paths read as the
  exception. `Logger`'s head-neutral default is a sink-less `NoopLogger` for the
  same reason: the head-neutral tier has nothing to write to, and
  `createLspServerSharedModule` binds `LspLogger`, which writes to
  `window/logMessage` once a connection is bound and to `stderr` before that.
  The GLSP and data heads do not rebind `Logger`; the GLSP head adapts it into
  GLSP's logger vocabulary (`GlspClientLogger`), so one threshold governs every
  head's output.
- **`workspace.FileSystemProvider` holds a `FileSystemProviderRegistry` whose
  `host` is the empty provider on the `.` entry.** That reads as a stub and is
  not one: it keeps `node:fs` out of the core barrel, so `.` stays usable in a
  browser. A Node host passes `@hydranium/core/node`'s
  `DefaultFileSystemProvider`, wired to `SelfSaveRegistry`, through
  `context.fileSystemProvider`, and it becomes the `host`. The registry
  dispatches by scheme, to the `fileSystemProviders` group first (the framework
  registers `virtual:` there) and to its `host` for every other scheme.
- **Some shared slots are constructed before the first build**, though DI is
  otherwise lazy: their constructors attach `documentBuilder` listeners or
  register a build-phase pass, and a listener attached on first _read_ attaches
  after the build that needed it. The set is `DEFAULT_EAGER_SERVICES`
  (`core/src/langium/bootstrap.ts`), not part of the module factory, because
  eagerness belongs to the bootstrap order rather than to the binding. It is
  shared-tier only: running it per language would attach every listener once
  per grammar.
- **`model.TransferEncoder` is shared while `serializer.Serializer` is
  per-language**, though both translate an AST into an external shape. File
  syntax is defined by the grammar, so there is no one serializer for two
  grammars. The wire vocabulary is defined by the protocol: forms, property
  views and diagrams speak one transfer vocabulary, and which grammar produced
  the AST behind it is an implementation detail they must not see. Across
  order-flow's grammars its encoder has one grammar-conditional branch, and
  that branch unifies two document roots into one wire root. Should two
  genuinely different client vocabularies appear, the change is additive: a
  per-language `TransferEncoder` slot, with the shared one delegating per URI
  as `ModelService.serialize` does for `Serializer`.

Some of Langium's shared slots, the `lsp.Connection` and `LanguageServer`
surface, flow through unchanged. Others are narrowed at the _type_ level as well
as rebound, each marked `/* override */` at its declaration in
`core/src/langium/module.ts`; grep the marker rather than trusting a list.

## Head-neutral and head-specific

Placement has a second axis that crosses the first: a service is head-neutral
(`core`, used by every head) or head-specific. Each head layers its own modules
after core's, **on both tiers**: the LSP head's `createLspServerLanguageModule`
binds per-language head-specific slots such as `lsp.CompletionProvider`, and
`createLspServerSharedModule` the shared ones, `lsp.DocumentUpdateHandler` and
the `Logger`. Head-specific shared slots are layered on the shared module, not
declared in `ServerAddedSharedServices`.

A head does not choose which tier a slot lives on; Langium's own service types
decide. That is why `sharedModules.extra` exists on `createIntegrationServices`:
`lsp.DocumentUpdateHandler` is read off the shared tree by
`startLanguageServer`, so a per-language binding of it is silently inert.

## Teaching cases

- **`BuildPipelineIntegration`: a shared orchestrator over per-language
  workers.** The pipeline owns the build-phase listeners and must attach them
  once, so it is shared. The work it triggers, integrity rules and AST
  extensions, depends on the grammar, so it routes each document to that
  document's own `IntegrityService` and `AstExtensionService` through the
  `ServiceRegistry`. Those services are built lazily on first access per
  language; the pipeline forces them at the first build phase that needs them
  and touches each language's `ValidationContributionCollector`, so checks are
  registered before `Validated`.
- **`Serializer`: per-language, dispatched per URI.** `ModelService.serialize`
  resolves `ServiceRegistry.getServices(uri).serializer.Serializer`, so each
  file reaches the serializer of its own language.
- **`ServiceRegistry`: the bridge.** Every path from a shared service to a
  per-language one goes through it. It is shared, since there is one dispatch
  table, and it is the single seam between the two tiers.

## Why there is no composition helper

There is deliberately no framework helper around Langium's `inject(...)`: no
factory taking per-slot hooks, no builder over the module chain. A helper like
that costs what a wrapper over a native idiom generally costs. Its hooks return
the framework's _base_ types, widening over an adopter's narrowed subclass, so
adopters bypass it. Only some slots get hooks, with no rule for which. And
`inject()`'s ordering, which is what decides which binding wins, disappears
behind generic parameters, to save a few lines per consumer.

The rule that generalises: when a framework helper would only wrap a Langium
idiom, don't write it. Reach for an abstraction when it removes a real
foot-gun, a silent ordering bug or a narrowing that gets lost, not for a smaller
surface alone. The same reasoning rules out class-based composition with
`protected createXxx()` hooks: a DI slot override already cascades.

## Why contributions

Registering items in a registry subclass's constructor has three problems,
which the contribution model removes:

- **Nothing declares in one place** what a language contributes; rules and
  checks scatter across subclass bodies.
- **A feature spanning two registries has no natural home.** An AST extension
  and the scope extension resolving references against what it adds would be
  split across two subclasses, with their shared state threaded between them.
- **Each registry would have its own registration shape.** One convention
  covers every registry, and the imperative `register(item)` stays as the
  low-level path for registration at runtime.

Contribution groups are records rather than arrays because Langium's
`Module.merge` deep-merges records by key, so the framework's contributions and
an adopter's accumulate; an array slot would be replaced by the last module.
