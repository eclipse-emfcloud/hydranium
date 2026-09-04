# Shared vs per-language DI scope

Every `@hydranium/*` server service is bound in one of two kinds of
Langium dependency-injection module:

- a **shared module** — one instance for the whole workspace, reachable
  from any language and any protocol head via `services.shared.*`;
- a **per-language module** — one instance *per registered grammar*,
  reachable via `services.*` on that language's services tree (and from
  a shared service via `ServiceRegistry.getServices(uri)`).

Which kind a service goes in is not arbitrary. This page states the
rule, works it through the slots where the placement is a real decision,
and names the second axis (head-neutral vs head-specific) that crosses
it. **Neither section lists the slots**, deliberately: the two module
factories are the enumeration, and a slot list here would fall behind
them while still reading as complete, which is worse than no list at all
because a reader consults it *instead of* the code. What this page carries
instead is the criterion each tier admits a slot on, and the placements
whose reasoning is not visible at the binding. For *how* a
bound class consumes its services — the `(services, options = {})`
constructor shape, `ServerSharedServicesMinimal`, the contribution-group
idiom — see [`conventions.md`](../contributing/conventions.md); this page is only
about *placement*.

## The rule

> **Workspace-global state and lifecycle → shared.
> Behaviour parameterised by the grammar → per-language.**

A service is **shared** when there must be exactly one of it across all
languages and all heads — because it owns mutable workspace state (the
open-document store, the project registry), drives a single lifecycle
(the build pipeline), or is pervasive infrastructure with no grammar
dependency (the clock, the logger). Two instances would mean two
sources of truth.

A service is **per-language** when its behaviour is a function of the
grammar — how names and ids are computed, how a cross-reference scope is
resolved, how an AST is serialised, enriched, or validated. A
multi-grammar workspace needs a *different* instance of each of these
per language, dispatched per URI through the `ServiceRegistry`.

The deciding question for a new service: *"if a second grammar were
registered in the same workspace, would this need its own instance?"*
Yes → per-language. No (there is and must be only one) → shared.

### Not everything variable is variable *by grammar*

The rule as stated above under-determines one class of service, and the
gap is worth naming because it looks like a contradiction otherwise.

> **Behaviour parameterised by the GRAMMAR → per-language.
> Behaviour parameterised by the CLIENT PROTOCOL → shared.**

`serializer.Serializer` and `model.TransferEncoder` are both "translate
this AST into an external shape", and only the first is per-language.
That is not an oversight:

- **File syntax is grammar-defined.** Two files whose grammars differ
  parse and print differently *because* their grammars differ. There is
  no such thing as one serialiser for two grammars, so `Serializer` is
  per-language and resolved per URI.
- **The wire vocabulary is protocol-defined.** The form editor, property
  view and diagram client speak ONE transfer vocabulary; which grammar
  produced the AST behind it is an implementation detail they must not
  see. `DataServer<TTransfer, …>` agrees — one wire type per server is a
  fact about the protocol, not about any grammar.

So a multi-grammar adopter usually wants a *single* encoder whose typed
overlay spans every grammar, and per-`$type` hooks
(`finalizeTransferNode`, `resolvePropertyValue`) to shape each node. The
reference adopter is the evidence: across two grammars its encoder has
exactly one grammar-conditional branch, and that branch *unifies* the
two document roots into one wire root rather than differentiating them.
Two encoders emitting the same vocabulary would mean duplicating the
transfer map and every hook — the shared encoder with extra steps.

**If that ever inverts** — an adopter composing two languages whose
clients are genuinely different — the fix is additive, not a migration:
add a per-language `TransferEncoder` slot and have the shared one
delegate per URI, exactly as `ModelService.serialize` already does for
`Serializer`. Dispatch is free; Langium's `ServiceRegistry` is the
mechanism and it is already in the tree. Nothing about the current
placement forecloses it, which is why shared is the right default until
a second wire vocabulary actually exists.

Applying the clause to the rest of the tree: `ModelService` (the
in-process facade), the `DataServer` and the GLSP head are all shared
for the same reason — they *are* the protocol surface. `Clock`,
`Logger`, `Tracer` are shared because they are parameterised by neither.

## Shared services

Bound by `createServerSharedModule` (`core/src/langium/module.ts`),
typed by `ServerAddedSharedServices`. All protocol heads read these;
per-head shared additions, if any, are layered by modules composed
after this one (see *Head-neutral vs head-specific* below).

**The factory is the enumeration, on this tier as on the per-language one.** Open
that `Module` literal: it is grouped exactly as the shared services tree is, the
`ServerAddedSharedServices` declaration above it documents what each slot is for,
and the factory comments the defaults whose choice is not self-evident.

Read it against *The rule* above rather than for its own sake. Every slot in it
is something there must be exactly ONE of across every language and every head —
workspace-global mutable state, a single lifecycle, or infrastructure
parameterised by neither the grammar nor the client protocol. The test is the
mirror of the per-language one: a proposed slot a second registered grammar would
need its own instance of belongs on the per-language tier instead.

Four placements the code states but cannot argue for, because each is a choice
between two defensible answers:

- **`Clock` and `Logger` are top-level slots, not members of `client`.** Both are
  general infrastructure reached from paths that have no client at all —
  headless CLI runs measure time and log — so grouping either under a
  client-facing namespace would make the clientless paths read as the exception.
  `Logger`'s head-neutral default is a sink-less `NoopLogger` for the same
  reason: the head-neutral tier has nothing to write to, and
  `createLspServerSharedModule` supplies the real sink (see *Head-neutral vs
  head-specific* below).
- **`workspace.FileSystemProvider` defaults to the EMPTY provider on the `.`
  entry**, which reads as a stub and is not one: it is what keeps `node:fs` out
  of the core barrel, so the `.` entry stays browser-neutral. A Node host binds
  `@hydranium/core/node`'s `DefaultFileSystemProvider`, wired to
  `SelfSaveRegistry`.
- **Some of these slots must be constructed BEFORE the first build**, though DI
  is otherwise lazy: their constructors attach `documentBuilder` listeners or
  register a build-phase pass, and a listener attached on first *read* attaches
  after the build that would have used it. The set lives in
  `DEFAULT_EAGER_SERVICES` (`core/src/langium/bootstrap.ts`), not in the module
  factory, because eagerness is a property of the bootstrap order rather than of
  the binding — and it is shared-tier only, since running it per language would
  attach every listener N times.
- **`model.TransferEncoder` is shared while `serializer.Serializer` is
  per-language**, though both translate an AST into an external shape. That is
  the *Not everything variable is variable by grammar* clause above, and it is
  the one asymmetry on this page a reader is most likely to take for an
  oversight.

(Most of Langium's own shared slots — `LangiumDocuments`, the `lsp.Connection` /
`LanguageServer` surface — flow through unchanged. Seven are narrowed at the
*type* level as well as rebound: `ServiceRegistry`, `TextDocuments`,
`WorkspaceManager`, `IndexManager`, `DocumentBuilder`, `WorkspaceLock` and
`FileSystemProvider`, each marked `/* override */` at its declaration in
`core/src/langium/module.ts` — grep that marker rather than trusting this list.
`LangiumDocumentFactory` is rebound too, to `HydraniumLangiumDocumentFactory`,
but carries no `/* override */`: the subclass adds no public surface, only a
`fromModel` that links containers and fills in text via the per-language
`Serializer`, so narrowing the declared type would buy a consumer nothing.)

## Per-language services

Bound by `createServerLanguageModule` (`core/src/langium/language-module.ts`),
typed by `ServerAddedServices`. One instance per registered grammar.

**The factory is the enumeration, and it is deliberately not mirrored here.** A
table of the per-language slots used to stand at this point in the page, and it
rotted: it fell behind the module while still reading as complete, which is
worse than no table at all, because a reader consults it *instead of* the code.
Open `language-module.ts` — it returns one `Module` literal, grouped exactly as
the services tree is, and each non-obvious default carries the comment that
explains it.

Read that literal against *The rule* above rather than for its own sake. Every
slot in it is behaviour a second registered grammar would need its own instance
of: how symbols are exported and named, how a cross-reference resolves and
completes, how an AST is serialised, enriched, rewritten or validated. A
proposed slot you cannot justify that way belongs on the shared tier instead.

## Head-neutral vs head-specific (the second axis)

Placement has a second, orthogonal axis: a service can be **head-neutral**
(`core`, shared by every protocol head) or **head-specific** (only
the LSP / GLSP / data head needs it). This crosses the shared ↔
per-language axis:

- `createServerSharedModule` / `createServerLanguageModule` (in
  `@hydranium/core`) provide the **head-neutral** bindings — everything
  bound by the two factories above.
- Each head package layers its own modules *after* core's, **on both
  tiers**. The LSP head (`@hydranium/core/lsp`) contributes
  `createLspServerLanguageModule` for its **per-language, head-specific**
  slots (`lsp.CompletionProvider`) and `createLspServerSharedModule` for
  its **shared, head-specific** ones — `lsp.DocumentUpdateHandler`, and
  `Logger`, which it replaces with `LspLogger`. That second binding is
  why the head-neutral `NoopLogger` default is not the end of the
  story: a server tree composed without it emits nothing at all, and
  composing it is what gives the framework a sink (the
  `window/logMessage` channel once a `Connection` is bound, `stderr`
  before that — which is also what makes a spawned server's
  `--log-level` reach anything). The GLSP and data-server heads
  contribute their own modules likewise; neither rebinds `Logger` — the
  GLSP head adapts the bound one into GLSP's own logger vocabulary
  (`GlspClientLogger`) rather than replacing the slot, so one threshold
  still governs every head's output.
  Head-specific shared slots are layered on top of the shared module, not
  declared in `ServerAddedSharedServices`.

  > **Why the head needs both tiers.** A head does not get to choose which
  > tier a slot lives on — Langium's own service types decide. Binding a
  > shared slot on the per-language tier type-checks (the module's type
  > parameter is an intersection) and then does nothing: nothing reads it,
  > and DI being lazy, it is never even constructed — so the mistake has no
  > symptom at composition time. `sharedModules.extra` on
  > `createIntegrationServices` exists to give a head-specific shared module
  > somewhere correct to go. The tell that a slot is on the wrong tier is a
  > constructor reaching for `services.shared`.

So `lsp.CompletionProvider` sits at one intersection — per-language
(grammar-shaped completion) **and** head-specific — while
`lsp.DocumentUpdateHandler` sits at the other: shared (one document-sync
listener set per server, parameterised by the client protocol rather than
the grammar) **and** head-specific. The composition order that assembles
both axes:

```ts
// shared, once per workspace:
const shared = inject(
   createDefaultSharedModule(ctx),
   MyGrammarGeneratedSharedModule,
   createServerSharedModule(ctx),     // framework head-neutral shared defaults
   createLspServerSharedModule(ctx),  // LSP head, shared tier (optional)
   MyAddedSharedModule                // adopter overrides (later-wins)
);

// per-language, once per grammar:
const language = inject(
   createDefaultModule({ shared }),
   MyGrammarGeneratedModule,
   createServerLanguageModule(ctx),     // framework head-neutral language defaults
   createLspServerLanguageModule(ctx),  // LSP head (optional)
   MyAddedLanguageModule                // adopter overrides (later-wins)
);
```

`createServerLanguageModule` must be merged before any head module — the
head modules only add their own slots and rely on core's references /
naming bindings being present. Adopter modules go last so their
overrides win (later-wins). See `conventions.md` → *Constructor shape*
for the binding idiom each factory uses.

## Teaching cases

- **`BuildPipelineIntegration` — shared orchestrator, per-language
  workers.** The build pipeline is one object (shared): it owns the
  build-phase listeners and must be a singleton so they attach once. But
  the work it triggers — running integrity rules, computing AST
  extensions — is grammar-specific, so it *routes* each document to that
  document's own per-language `IntegrityService` / `AstExtensionService`
  via the `ServiceRegistry`. The orchestrator's singleton-ness and the
  workers' per-language-ness are both consequences of the rule, not a
  contradiction of it.

- **`Serializer` — per-language, dispatched per-URI.** There is no single
  "the serializer". `ModelService.serialize` resolves
  `ServiceRegistry.getServices(uri).serializer.Serializer`, so a
  multi-grammar workspace routes each file to the serialiser bound in
  its own language module. The framework default throws a clear "no
  Serializer registered" error; the binding is the adopter's job.

- **`ServiceRegistry` — the bridge.** Every "shared service reaches a
  per-language service" path goes through `ServiceRegistry`
  (`services.shared.ServiceRegistry.getServices(uri)`). It is itself
  shared (there is one dispatch table) and returns the per-language
  `ServerLanguageServices` tree. This is the single seam between the two
  scopes.

## Where adopters override

Both module factories use Langium's later-wins composition, so an
adopter rebinds *any* framework slot by binding it again in a module
composed after the framework's. Override on the side the slot lives:
a custom `ProjectManager` goes in the adopter's shared module; a custom
`NameProvider` or `Serializer` goes in the adopter's language module.
Re-declaring a framework slot in the adopter's added-services interface
(e.g. `OrderFlowAddedSharedServices.workspace.ProjectManager`) is what
makes it type-level rebindable.
