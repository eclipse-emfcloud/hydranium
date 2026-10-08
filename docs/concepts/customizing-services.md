# Customizing services

Hydranium's services are Langium services, bound by dependency injection. You
change one by binding your own in a module composed after the framework's:
the later binding wins, and the rest of the framework keeps working around it.
This page covers where a binding goes, how the modules compose, how to add to
the framework's registries without replacing them, and how to serve documents
from a filesystem of your own.
[Customizing names, scope and visibility](customizing-names-and-scope.md)
covers the scoping services in particular.

## Two tiers: shared and per-language

Every service is bound in one of two kinds of module:

- a **shared module**: one instance for the whole workspace, reached as
  `services.shared.*` from any language and any head;
- a **per-language module**: one instance per grammar, reached as `services.*`
  on that language's services, and from a shared service through
  `ServiceRegistry.getServices(uri)`.

> **Workspace-global state and lifecycle go in the shared module. Behaviour
> that depends on the grammar goes in the per-language one.**

A service is shared when there must be exactly one of it: it owns workspace
state such as the open documents or the projects, drives the one build
lifecycle, or is infrastructure such as the clock or the logger. A service is
per-language when what it does depends on the grammar: how names are computed,
how a reference is scoped, how a model is serialized or validated. The test for
a service of your own: _if a second grammar were registered in the same
workspace, would it need its own instance?_ If yes, it is per-language.

Not everything that varies, varies by grammar. A `Serializer` is per-language,
because two grammars print text differently. The `TransferEncoder` is shared,
because the clients of the data head speak one transfer vocabulary whichever
grammar a document has. A workspace with several grammars therefore usually
wants one encoder that covers them all, with per-`$type` hooks
(`finalizeTransferNode`, `resolvePropertyValue`) to shape each node.

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

Compose them with Langium's `inject` directly; the framework adds no wrapper
around it. `init` writes this composition for you, and
[Compose a server by hand](../guides/compose-a-server.md) builds it without
`init`.

What goes wrong, and says nothing when it does:

- **A binding on the wrong tier does nothing.** Binding a shared slot in a
  per-language module type-checks, and then nothing ever reads it. Override on
  the tier the slot lives on: a custom `ProjectManager` goes in your shared
  module, a custom `NameProvider` in your language module. A head-specific
  shared module goes in `sharedModules.extra` on `createIntegrationServices`.
  The tell that a service is on the wrong tier is a constructor reaching for
  `services.shared`.
- **Without the LSP head's shared module, nothing logs.** The framework's
  head-neutral logger has nowhere to write; `createLspServerSharedModule`
  supplies the real one.
- **The framework's language module comes before any head module**, because
  the heads rely on its bindings.
- **Extend the framework's class, not the upstream one.** Where the framework
  binds its own subclass of a Langium service, a rebinding to the upstream
  class silently drops what the framework added;
  [Troubleshooting](../adopting/troubleshooting.md#a-framework-fix-disappears-after-you-rebind-a-service)
  says how to tell.

Two more rules:

- **Bind a `Serializer` in each language module.** The framework's default
  throws, because only your language knows its text.
- **Re-declare a slot to rebind it with a narrower type.** Declaring a
  framework slot again in your added-services interface, such as
  `workspace.ProjectManager`, is what lets you bind your own subclass there
  and read it back as that subclass.

On the GLSP head, the `appModules` you pass load after the framework's
bindings, so they can `rebind` its tokens.

## Contributions: adding to the registries

Five framework services hold registries an adopter adds to: integrity rules,
validation checks, AST extensions, scope extensions and build-phase passes. You
add to them by declaring **contributions** under the registry's group, in your
language module, or in your shared module for build-phase passes. Each service
reads its group when it is built, and calls every contribution with itself as
the registry.

| Registry service | Group | Contribution interface | Method |
|---|---|---|---|
| `IntegrityService` | `integrity.rules` | `IntegrityRuleContribution` | `registerIntegrityRules(registry)` |
| `ValidationContributionCollector` | `validation.checks` | `ValidationCheckContribution` | `registerValidationChecks(registry)` |
| `AstExtensionService` | `ast.extensions` | `AstExtensionContribution` | `registerAstExtensions(registry)` |
| `ScopeExtensionService` | `references.scopes` | `ScopeExtensionContribution` | `registerScopeExtensions(registry)` |
| `BuildPhasePassService` (shared) | `buildPhasePasses` | `BuildPhasePassContribution` | `registerBuildPhasePasses(registry)` |

The methods carry their registry in their name, so one class can implement
several contribution interfaces without a collision.

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
- **Bind a feature that spans registries once.** A class that contributes to
  two registries, say an AST extension and the scope extension that resolves
  references against what it adds, is bound once under a `features` group of
  your own and referenced from each registry's group. Langium caches the
  binding, so every reference gets the same instance:

<!-- snippet-skip: class body truncated mid-declaration -->

```ts
class ElementAliasFeature
   implements AstExtensionContribution, ScopeExtensionContribution
{
   constructor(private services: MyServices) {}
   registerAstExtensions(reg: AstExtensionRegistry): void { /* ... */ }
   registerScopeExtensions(reg: ScopeExtensionRegistry): void { /* ... */ }
}

// Bound once at a feature slot:
features: {
   elementAliases: services => new ElementAliasFeature(services)
},
// Referenced from each registry's group — same cached singleton:
ast: {
   extensions: {
      elementAliases: services => services.features.elementAliases
   }
},
references: {
   scopes: {
      elementAliases: services => services.features.elementAliases
   }
}
```

- **Type the module with `DeepPartial<ServerAddedServices>`** to bind into the
  framework's groups without re-listing them in your added-services interface:

<!-- snippet-skip: module factory with an elided `{ /* ... */ }` body -->

```ts
function createMyLanguageModule(ctx: ServerModuleContext):
   Module<MyServices, PartialLangiumServices & DeepPartial<ServerAddedServices> & MyAddedServices>
{ /* ... */ }
```

- **`registry.register(item)` still works** for registration at runtime, in
  tests or behind a feature flag. A contribution is a declared producer of the
  same calls.
- **An override of `callIntegrity` on `BuildPipelineIntegration` calls
  `super`.** Besides running the integrity rules, it is what registers your
  validation checks before the build validates; an override that skips it
  has to touch each language's `ValidationContributionCollector` itself.

### Which registry build work goes in

Three of the registries run work during a build. Pick by what the work walks
and by whether it needs the whole batch built first:

| | Per document, as each is built | Once per build, over the batch |
|---|---|---|
| **Per node** | `AstExtension`: computed or synthetic properties | `IntegrityRule`: AST corrections that may change the text and reparse |
| **Whole unit** | no registry: use an `AstExtension` whose `nodeFilter` matches only the root | `BuildPhasePass`: work across documents, such as resolving inherited members parent first |

A `BuildPhasePass` runs in ascending `priority` within its phase, ties in the
order registered. Give yours `0` or higher, and order passes that build on one
another with increasing values: the negative band is the framework's, for
passes such as integrity whose output the rest of the phase reads.

## Serving documents from another filesystem

The workspace reads files through the shared `workspace.FileSystemProvider`, a
`FileSystemProviderRegistry` that dispatches by URI scheme. The framework
serves `virtual:` itself, and every other scheme goes to the registry's `host`,
the provider your host passes as `context.fileSystemProvider`.

- **A document outlives its last close only where a provider serves it.** Once
  no client holds a document, the framework rebuilds it from the provider when
  the provider's `exists` answers for it, and removes it from the workspace
  otherwise, as it does an editor's `untitled:` buffer or a `file:` document
  created and never saved. The last client's unsaved edits go either way.
- **Give another scheme a provider of its own** in the shared
  `fileSystemProviders` group, keyed by the scheme without its colon. Your own
  provider then answers for its own schemes only:

<!-- snippet-preamble
import { InMemoryFileSystemProvider } from '@hydranium/core';
-->

```ts
const sharedModule = {
   fileSystemProviders: {
      library: (shared: ServerSharedServices) =>
         new InMemoryFileSystemProvider(shared, { seed: { 'library:/types.domain': 'valuetype Text {}' } })
   }
};
```

- **Serve what you seed.** The workspace manager warns once at startup when no
  provider can serve a document seeded from the `additionalDocuments` group or
  an override of `loadAdditionalDocuments`, naming each such scheme and up to
  three of the URIs, since each leaves the workspace at its last close.
  Register a provider for the scheme, or serve it from the host's provider. A
  host that drops such documents on purpose passes
  `warnUnservedDocuments: false` to `HydraniumWorkspaceManager`.
- **Reach your own provider through `host`.** The slot types its host as a
  plain `WritableFileSystemProvider`. To use your provider's own members,
  replace the slot's declaration in your services type with
  `WithServiceOverrides`, and bind the registry with that host:

<!-- snippet-preamble
import {
   DefaultFileSystemProviderRegistry,
   type FileSystemProviderRegistry,
   InMemoryFileSystemProvider,
   type WithServiceOverrides
} from '@hydranium/core';
import { type DeepPartial, type Module, URI } from '@hydranium/langium';
declare const shared: MyServices;
-->

```ts
type MyServices = WithServiceOverrides<
   ServerSharedServices,
   { workspace: { FileSystemProvider: FileSystemProviderRegistry<InMemoryFileSystemProvider> } }
>;

const sharedModule: Module<MyServices, DeepPartial<MyServices>> = {
   workspace: {
      // Annotated: a module's slots are DeepPartial, so only the return type
      // checks the host.
      FileSystemProvider: (services): FileSystemProviderRegistry<InMemoryFileSystemProvider> =>
         new DefaultFileSystemProviderRegistry(services, { host: new InMemoryFileSystemProvider(services) })
   }
};

shared.workspace.FileSystemProvider.host.setFile(URI.parse('memory:///ws/a.domain'), 'entity A {}');
```

## Synthetic content

Some content of a language comes from no file: a standard library, built-in
types. Hydranium marks such content in two ways, at two granularities:

- **a `virtual:` URI** for a whole document whose AST is built in code. Build
  one with `virtualUri`, and check one with `isVirtualUri`;
- **a `$synthetic: true` flag** for a single node built in code, typically a
  mirror beside a real declaration. Set it with `markSynthetic` or
  `markSyntheticTree`, and check it with `isSyntheticNode`.

Neither is validated: a diagnostic on a virtual document could never be acted
on, and a synthetic node mirrors something that is validated where it is
declared. `DocumentValidatorOptions` turns either back on
(`validateVirtualDocuments`, `validateSyntheticNodes`). Both ride on the
framework's `HydraniumDocumentValidator`, so a validator of your own extends
it rather than replacing it:

```ts
class MyDocumentValidator extends HydraniumDocumentValidator {
   protected override shouldSkipValidation(node: AstNode): boolean {
      return super.shouldSkipValidation(node) || isDeprecated(node);
   }
}
```

Build a synthetic document with Langium's `LangiumDocumentFactory.fromModel`:

```ts
import { markSyntheticTree, virtualUri } from '@hydranium/core';

// 1. Build the AST root by hand. Casting through `unknown` is
//    acceptable — synthetic AST nodes do not go through the parser.
const stdlibRoot: Root = {
   $type: 'Root',
   name: 'std',
   elements: [...stdlibElements]
} as unknown as Root;

// 2. (optional) Opt every node in the tree into skip-validation.
markSyntheticTree(stdlibRoot);

// 3. Materialise the LangiumDocument.
const stdlibDoc = services.shared.workspace.LangiumDocumentFactory
   .fromModel(stdlibRoot, virtualUri('stdlib', 'stdlib.lang'));

// 4. The document is now suitable for the tier factories on
//    HydraniumAstNodeDescriptionProvider.
provider.createUniversal({ node, name: node.name, document: stdlibDoc });
```

Two things decide whether anything can see it:

- **Register it, or it is invisible.** A document built this way is not part of
  the workspace until an `AdditionalDocumentContribution` in the shared
  `additionalDocuments` group returns it. Only then is it built and indexed like
  a file. A virtual document that is never registered reaches no scope, and
  nothing reports it.
- **End its URI with a registered file extension.** A document finds its
  language by extension, so a URI without one belongs to no language.

To compare against synthetic nodes from anywhere, export them as module-level
constants and compare by identity:

<!-- snippet-preamble
import { virtualUri } from '@hydranium/core';
-->

```ts
// stdlib.ts (an adopter's synthetic stdlib module)
export const STDLIB_URI = virtualUri('stdlib', 'stdlib.lang');

export const STDLIB_ANY_ELEMENT: Element = {
   $type: ElementMeta.$type,
   name: 'Any'
} as unknown as Element;

export const STDLIB_ELEMENTS: readonly Element[] = [STDLIB_ANY_ELEMENT];

export const STDLIB_ROOT: Root = {
   $type: RootMeta.$type,
   name: 'std',
   elements: [...STDLIB_ELEMENTS]
} as unknown as Root;
```

<!-- snippet-preamble
import { isVirtualUri } from '@hydranium/core';
declare const STDLIB_ANY_ELEMENT: Element;
-->

```ts
// Identity check from anywhere
if (node === STDLIB_ANY_ELEMENT) { /* it's the stdlib's Any */ }

// Contributor check from a description
if (isVirtualUri(description.documentUri)) { /* virtual-document content */ }
```
