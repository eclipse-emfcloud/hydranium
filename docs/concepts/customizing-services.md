# Customizing services

Hydranium's services are Langium services, bound by dependency injection. To
change one, you bind your own in a module composed after the framework's. The
later binding wins, and the rest of the framework keeps working around it.

This page covers where your binding goes, how the modules compose, and how you
add to the framework's registries without replacing them.
[Customizing names, scope and visibility](customizing-names-and-scope.md)
covers the scoping services.

## Two tiers: shared and per-language

You bind every service in one of two kinds of module:

- a **shared module**: one instance for the whole workspace, reached as
  `services.shared.*` from any language and any head;
- a **per-language module**: one instance per grammar, reached as `services.*`
  on that language's services, and from a shared service through
  `ServiceRegistry.getServices(uri)`.

> **Workspace-global state and lifecycle go in the shared module. Behaviour
> that depends on the grammar goes in the per-language one.**

A service is shared when there must be exactly one of it. It owns workspace
state such as the open documents or the projects, drives the one build
lifecycle, or is infrastructure such as the clock or the logger. A service is
per-language when what it does depends on the grammar: how names are computed,
how a reference is scoped, how a model is serialized or validated.

For a service of your own, ask: _if a second grammar were registered in the
same workspace, would it need its own instance?_ If yes, it is per-language.

Not everything that varies, varies by grammar. A `Serializer` is per-language,
because two grammars print text differently. The `TransferEncoder` is shared,
because the clients of the data head speak one transfer vocabulary whichever
grammar a document has. With several grammars, you usually bind one encoder
that covers them all.

## Composing the services

The modules compose in a fixed order, on both tiers: Langium's defaults, your
generated module, the framework's defaults, the modules of the heads you run,
and your own module last, so that your bindings win.

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

You compose them with Langium's `inject` directly; the framework adds no
wrapper. `init` writes this composition for you, and
[Compose a server by hand](../guides/compose-a-server.md) builds it without
`init`.

These mistakes fail silently:

- **A binding on the wrong tier does nothing.** Binding a shared slot in a
  per-language module type-checks, and then nothing reads it. Override on the
  tier the slot lives on: a custom `ProjectManager` goes in your shared module,
  a custom `NameProvider` in your language module. A head-specific shared
  module goes in `sharedModules.extra` on `createIntegrationServices`. A
  constructor that reaches for `services.shared` tells you the service is on
  the wrong tier.
- **Without the LSP head's shared module, nothing logs.** The framework's
  head-neutral logger has nowhere to write; `createLspServerSharedModule`
  supplies the real one.
- **The framework's language module comes before any head module**, because
  the heads rely on its bindings.
- **Extend the framework's class, not the upstream one.** Where the framework
  binds its own subclass of a Langium service, rebinding the upstream class
  silently drops what the framework added.
  [Troubleshooting](../adopting/troubleshooting.md#a-framework-fix-disappears-after-you-rebind-a-service)
  says how to tell.

Two more rules:

- **Bind a `Serializer` in each language module.** The framework's default
  throws, because only your language knows its text.
- **Re-declare a slot to rebind it with a narrower type.** Declare the slot
  again in your added-services interface, such as `workspace.ProjectManager`.
  Then you can bind your own subclass there and read it back as that subclass.

On the GLSP head, the `appModules` you pass load after the framework's
bindings, so they can `rebind` its tokens.

## Contributions: adding to the registries

Five framework services hold registries you add to: integrity rules,
validation checks, AST extensions, scope extensions and build-phase passes.
You add to one by declaring a **contribution** under the registry's group.
Build-phase passes go in your shared module; the others go in your language
module. Each service reads its group when it is built, and calls every
contribution with itself as the registry.

| Registry service | Group | Contribution interface | Method |
|---|---|---|---|
| `IntegrityService` | `integrity.rules` | `IntegrityRuleContribution` | `registerIntegrityRules(registry)` |
| `ValidationContributionCollector` | `validation.checks` | `ValidationCheckContribution` | `registerValidationChecks(registry)` |
| `AstExtensionService` | `ast.extensions` | `AstExtensionContribution` | `registerAstExtensions(registry)` |
| `ScopeExtensionService` | `references.scopes` | `ScopeExtensionContribution` | `registerScopeExtensions(registry)` |
| `BuildPhasePassService` (shared) | `buildPhasePasses` | `BuildPhasePassContribution` | `registerBuildPhasePasses(registry)` |

Each method names its registry, so one class can implement several
contribution interfaces without a collision.

```ts
class WellFormednessRulesContribution implements IntegrityRuleContribution {
   registerIntegrityRules(registry: IntegrityRuleRegistry): void {
      registry.register(new ElementNameUniquenessRule());
      registry.register(new ElementTypeRule());
   }
}

// In the per-language module. The sub-key names the group the adopter chose,
// not an AST type — it only has to be unique within `integrity.rules`.
integrity: {
   rules: {
      wellFormedness: () => new WellFormednessRulesContribution()
   }
}
```

- **Groups are keyed, not arrays.** Contributions under distinct keys
  accumulate across modules, so yours add to the framework's rather than
  replace them.
- **Never use the key `framework`.** The framework registers its own
  contributions under it, and a binding of yours under the same key replaces
  them.
- **Bind a class that contributes to two registries once.** Bind it under a
  group of your own, and reference that binding from each registry's group.
  Langium caches the binding, so both registries get the same instance.
- **Type the module with `DeepPartial<ServerAddedServices>`** to bind into the
  framework's groups without re-listing them in your added-services interface:

<!-- snippet-skip: module factory with an elided `{ /* ... */ }` body -->

```ts
function createMyLanguageModule(ctx: ServerModuleContext):
   Module<MyServices, PartialLangiumServices & DeepPartial<ServerAddedServices> & MyAddedServices>
{ /* ... */ }
```

### Which registry build work goes in

Three of the registries run work during a build. Pick by what the work walks,
and by whether it needs the whole batch built first:

| | Per document, as each is built | Once per build, over the batch |
|---|---|---|
| **Per node** | `AstExtension`: computed or synthetic properties | `IntegrityRule`: AST corrections that may change the text and reparse |
| **Whole unit** | no registry: use an `AstExtension` whose `nodeFilter` matches only the root | `BuildPhasePass`: work across documents, such as resolving inherited members parent first |

Build-phase passes run in ascending `priority` within their phase, ties in the
order registered:

- Give yours `0` or higher.
- Order passes that build on one another with increasing values.
- The negative band is the framework's, for passes such as integrity whose
  output the rest of the phase reads.

## Serving documents from another filesystem

The workspace reads files through the shared `workspace.FileSystemProvider`.
It dispatches by URI scheme: the framework serves `virtual:` itself, and every
other scheme goes to the provider your host passes as
`context.fileSystemProvider`.

Once no client holds a document, the framework rebuilds it from that provider
if the provider's `exists` answers for it. Otherwise it removes the document,
as it does an editor's `untitled:` buffer.

If you seed documents under a scheme of your own, the workspace manager warns
at startup that no provider serves them, and says how to fix it. The TSDoc of
`FileSystemProviderRegistry` covers giving a scheme its own provider.

## Synthetic content

Content that no file backs, such as a standard library, lives in a `virtual:`
document. [Ship a standard library](../guides/ship-a-standard-library.md) shows
how to build one.

A single node built in code beside a real declaration is marked with
`markSynthetic` instead; its TSDoc covers the marker and how validation treats
it.
