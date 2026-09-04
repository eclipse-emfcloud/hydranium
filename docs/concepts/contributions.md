# Adopter contributions — synthetic AST and registration

The two ways an adopter adds material to a language beyond its grammar:
**synthetic AST**, which puts nodes and whole documents into the workspace
that no file produced, and **registration contributions**, the one declarative
pattern all four registry services share.

They are one page because they are routinely used together — a stdlib is
synthetic content that has to be registered before anything can see it — and
because both are places where an adopter's code is called by the framework
rather than the other way round.

## Synthetic AST contributions

"Synthetic" in `@hydranium/core` means **constructed in memory, not
parsed from source**. Two independent mechanisms detect the same
underlying property, applied at different granularities:

- **`virtual:` URI scheme** — identity for whole documents whose
  root AST is built in code (stdlib classes, library types,
  contributor pseudo-classes). Use {@link virtualUri} to construct
  these URIs; {@link isVirtualUri} checks the scheme.
- **`$synthetic: true` flag** — per-node marker for nodes built in
  code, typically AST-extension mirrors that exist alongside a "real"
  authoritative copy. Set via {@link markSynthetic}; check via
  {@link isSyntheticNode}.

The two mechanisms compose: a node is synthetic if either applies.
Adopters can mix freely — synthetic documents with selective
mirroring, real documents with synthetic mirrors, or both.

### Identity vs behaviour

The split between URI scheme and `$synthetic` flag is intentional:

- **URI scheme is document-level** — it names the contributor (for
  telemetry, diagnostics, and UI filtering such as "hide stdlib results
  from go-to-definition"), and it is the axis
  `HydraniumDocumentValidator.validateDocument` reads: a virtual document
  is not validated at all, because a virtual URI cannot be opened so a
  diagnostic on it is un-actionable. Governed by
  `DocumentValidatorOptions.validateVirtualDocuments` (default `false`).
- **`$synthetic` flag is the node-level opt-in** —
  `HydraniumDocumentValidator.shouldSkipValidation` returns `true` for
  marked nodes by default, so validation skips them and their
  children. Governed by
  `DocumentValidatorOptions.validateSyntheticNodes` (default `false`).

Both behaviours ride on the one `validation.DocumentValidator` binding
`createServerLanguageModule` makes; an adopter that rebinds the slot to
something other than a `HydraniumDocumentValidator` subclass loses both.

The two axes stay decoupled so a synthetic node in an ordinary on-disk
document is skipped while its authoritative declaration is validated, and
so a virtual document whose content SHOULD be checked (a dev/CI head) is
reachable by flipping one option rather than by un-marking nodes.

### Building a synthetic document

Use Langium's `LangiumDocumentFactory.fromModel` — there is no
parallel framework helper. The factory lives on shared services
(`services.shared.workspace.LangiumDocumentFactory`), so it is
reachable everywhere, including shared-services-subclass
construction time.

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

A document built this way is not yet part of the workspace. There are
two ways to use it, and they are not interchangeable:

- **Description-only** — hand it straight to the tier factories, which
  need it purely to derive `documentUri` and keep the description shape
  uniform with document-backed nodes. Nothing indexes it.
- **Indexed** — register it from an `AdditionalDocumentContribution`
  under the shared `additionalDocuments` group, which is the ONLY route
  into the workspace (`HydraniumWorkspaceManager.loadAdditionalDocuments`
  drives it once at startup). It is then built through the ordinary
  pipeline like any file, and survives a re-read through the framework's
  virtual-aware `FileSystemProvider`. A virtual document that is never
  registered there contributes to no scope, with no error.

End the URI with a **registered file extension** either way: the service
registry maps a document to its language by extension, so a bare
`virtual:stdlib` resolves to no language at all.

### Pattern — extract synthetic AST as module-level constants

Adopters with non-trivial synthetic content benefit from exporting
each synthetic node as a module-level `const` so consumers can do
identity comparisons across module boundaries.

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

Consumers can then:

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

### Composing skip-validation reasons

Adopters with skip-validation conditions beyond `$synthetic` compose
on top of the framework default rather than replace it:

```ts
class MyDocumentValidator extends HydraniumDocumentValidator {
   protected override shouldSkipValidation(node: AstNode): boolean {
      return super.shouldSkipValidation(node) || isDeprecated(node);
   }
}
```

The default reaches `isSyntheticNode(node)` through the framework
free function, so `super.shouldSkipValidation(node)` preserves the
synthetic-mirror skip without re-implementing the flag check.

## Registration contributions

The framework's four registry services — `IntegrityService`,
`ValidationContributionCollector` (a thin wrapper over Langium's
`ValidationRegistry`), `AstExtensionService`, `ScopeExtensionService` —
share one declarative registration pattern. Adopters declare
contributions in their per-language module under sub-key contribution
groups; each service reads its own group at construction and calls each
contribution's domain-qualified `registerXxx(registry)` method, handing
itself in as the registrar.

### Why a contribution model

Adopters subclassing the registry services and registering items in
the constructor — the alternative this model replaced — had three
problems:

- **No central declaration.** Rules / extensions / checks scattered
  across multiple subclass bodies; nothing pointed at one place to ask
  "what does this language contribute?"
- **Cross-cutting features had nowhere natural to live.** A single
  conceptual feature spanning two registries — an AST extension
  producing synthetic children plus a scope extension resolving
  references against those same children — had to be split across two
  subclasses, with shared helpers / state duplicated or awkwardly
  threaded between them.
- **The four registries had inconsistent registration shapes** —
  `IntegrityService.registerRule(rule)` imperative, AST/scope likewise,
  validation went through a free function calling Langium's
  `ValidationRegistry.register(checksMap)`. No single convention.

The contribution model unifies registration onto one convention while
keeping the imperative `register(item)` API as the low-level dynamic
path (tests, hot-reload, conditional/feature-flagged registration).

### The four contribution interfaces

Each registry has a `Registry` interface (handed to contributions; also
implemented by the service for imperative use) and a `Contribution`
interface (declared by adopters):

| Registry service | group slot | contribution interface | method |
|---|---|---|---|
| `IntegrityService` | `integrity.rules` | `IntegrityRuleContribution` | `registerIntegrityRules(registry)` |
| `ValidationContributionCollector` | `validation.checks` | `ValidationCheckContribution` | `registerValidationChecks(registry)` |
| `AstExtensionService` | `ast.extensions` | `AstExtensionContribution` | `registerAstExtensions(registry)` |
| `ScopeExtensionService` | `references.scopes` | `ScopeExtensionContribution` | `registerScopeExtensions(registry)` |

The method names are **domain-qualified** (`registerIntegrityRules`,
not bare `register`) so a cross-cutting class implementing multiple
contribution interfaces handles each without method collision.

### Standard adopter shape — single-registry case

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

One contribution can register many items (the contribution is the
grouping unit; rules carry their own per-item metadata such as
`phase`, `nodeType`, `id`).

### Cross-cutting features — bind once, reference N

A feature spanning multiple registries implements multiple contribution
interfaces. Bound **once** at a `features.*` slot, **referenced** from
each registry's contribution group — Langium's DI proxy caches the
factory result, so every reference returns the same singleton (the
Langium analog of Theia's `bind(F).toSelf().inSingletonScope()` +
`bind(Token).toService(F)`).

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

The `features` slot is **adopter-owned** — the framework does not
declare a `features` group on `ServerAddedServices`. Each adopter
adds its own `features` slot to the adopter-added services interface,
with strongly-typed feature classes.

### Sub-key groups (not bare arrays)

Each contribution group is a `Record<string, XxxContribution>`, NOT
a bare array. This exploits Langium's `Module.merge` deep-merge:
distinct sub-keys across framework defaults + adopter contributions
**accumulate** (deep-merge by key); a bare-array slot would last-wins
overwrite, dropping framework defaults unless adopters remember to
spread.

The framework binds its own contributions under a reserved `framework`
sub-key (currently just `validation.checks.framework =
NameSeparatorCheckContribution`). **Adopters MUST avoid the literal
`framework` key** — Langium's deep-merge is last-wins on same-keyed
leaves, so reusing the key drops the framework default.

### Module return-type ergonomics — `DeepPartial<ServerAddedServices>`

The framework declares contribution-group slots on `ServerAddedServices`
as `Record<string, XxxContribution>`. Adopters that want their module
to bind into these slots without re-listing each contribution-class in
the adopter-added-services interface can widen the module return type
with Langium's `DeepPartial`:

<!-- snippet-skip: module factory with an elided `{ /* ... */ }` body -->

```ts
function createMyLanguageModule(ctx: ServerModuleContext):
   Module<MyServices, PartialLangiumServices & DeepPartial<ServerAddedServices> & MyAddedServices>
{ /* ... */ }
```

The `DeepPartial<ServerAddedServices>` factor makes every framework
slot optional in the module return type, so the adopter binds only the
contribution groups it populates. The adopter-added services interface
then only declares slots the adopter introduces (e.g. the `features`
group) or re-declares with adopter-specific tightening (e.g. an
`IntegrityService<MyRoot>` override for typed rule registration).

### Imperative API stays — the low-level dynamic path

Every registrar interface uses `register(item): Disposable`. The
registry service implements its own registrar interface — so existing
imperative call sites that need runtime-dynamic registration (tests,
hot-reload, feature-flagged contributions) continue to call
`registry.register(item)` directly. The contribution model is a
PRODUCER of `register(item)` calls at composition time, not a
REPLACEMENT for the imperative API.

### Build-pipeline trigger ergonomics

`IntegrityService`, `AstExtensionService`, and `ScopeExtensionService`
construct lazily on first per-language access. `BuildPipelineIntegration`
forces each of these to materialize during the first build phase
(`Parsed` for integrity, `ComputedScopes` for AST, query-time for
scope) and additionally touches
`languageServices.validation.ValidationContributionCollector` per
document so validation checks are registered with Langium's
`ValidationRegistry` before the `Validated` phase fires. Adopters
overriding `BuildPipelineIntegration` either call `super.callIntegrity`
or include the collector touch in their override.

## Related

- [Framework vs adopter](framework-vs-adopter.md) — the customization seams as
  a whole, framework default beside adopter override.
- [Build pipeline registries](build-pipeline-registries.md) — the
  granularity × trigger grid the registries above are driven from.
- [Scope and visibility](scope-and-visibility.md) — what the tier factories in
  the synthetic-document example are choosing between.
