# Scope and visibility

How the framework decides what an element can see and what can see it. Three
independent axes are involved, they are easy to conflate, and the whole model
falls apart when they are — so this page names them, states the filter rule
each tier gets, and then works through the two services that turn the model
into answers at a query site.

Read [Element addressing](element-addressing.md) first if the four
name-shaped terms are not yet familiar: the axes below are filters *over*
those names.

## Visibility model — three orthogonal axes

The framework's visibility model has three independent axes that are
easy to conflate. This section names them so they stay separate.

1. **Tier** — static metadata declaring intended visibility class for
   each `TieredAstNodeDescription`. Four values: `'local' | 'project'
   | 'public' | 'universal'`. Tier discriminates *which slice of the
   index* the description lives in and the filter rule that applies.
2. **Name** — the lookup key on each description. Three *qualification
   levels* exposed by `NameProvider`: bare (`getOwnName`),
   document-qualified (`getDocumentQualifiedName`), and
   project-qualified (`getProjectQualifiedName`). Typical pairing with
   tier is bare↔local, doc-qualified↔project, project-qualified↔public;
   `'universal'` accepts any name. Note the axes are independent —
   "qualification level" for this one, "tier" only for axis 1, even
   though both have members named `local` and `project`.
3. **Scope** — source-conditioned, tier-aware projection of the
   global index at a query site. The scoping operation (filter rules)
   turns tier-tagged descriptions into a layered queryable view.
   Composed inner-first by the framework default: document-local,
   `extension:local`, own-project, dependency, universal-index, and
   `extension:universal` outermost — the two extension layers sit at
   different chain positions, not one.
   Built automatically by `HydraniumScopeProvider`'s `getGlobalScope` →
   `getProjectScope`.

The distinction matters: **tier is a per-description label; scope is
a per-query result**. Tier is what each description IS; scope is what
each query SEES. The scoping operation is the function that maps the
former into the latter.

### Per-tier filter rules

| Tier          | `projectId`        | Default filter                                                                              |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `'local'`     | n/a                | not in global index (lives in Langium's precomputed per-document scope)                     |
| `'project'`   | **required**       | `description.projectId === sourceProjectId` (own project only — equality, not closure)      |
| `'public'`    | **required**       | `description.projectId !== sourceProjectId && visibleProjectIds.has(description.projectId)` |
| `'universal'` | **forbidden**      | `true` (visible everywhere unconditionally)                                                 |

### Java-analogy quick reference

Soft analogy for onboarding adopters familiar with mainstream OO
languages; the semantic differences matter when reasoning about edge
cases:

- `'local'` ≈ `private` (innermost — document-only)
- `'project'` ≈ `protected` (middle — project-bounded)
- `'public'` ≈ `public` (cross-boundary via dependency closure)
- `'universal'` ≈ system-level (no boundary)

Two semantic differences from Java to keep in mind:

- Java's `protected` is package + subclass; our `'project'` is
  project boundary only.
- Java's `public` is unconditional; our `'public'` is dependency-
  bounded (visible to dependents, hidden from unrelated projects, and
  hidden inside its own project by the own-project canonical filter so
  the project-tier sibling under a shorter name is the canonical entry
  there — unless an adopter opts in via `includeOwnProjectPublic`).

### Choosing a factory at emit time

`HydraniumAstNodeDescriptionProvider` exposes four typed factories
matching the four tiers — each enforces the projectId invariant at
the type level so misconstructed descriptions fail at compile time:

<!-- snippet-skip: tier-factory signatures listed bare, not calls against a provider -->

```ts
createLocal({ node, name, document })                         // tier: 'local'
createProject({ node, name, document, projectId })            // tier: 'project'  (projectId required)
createPublic({ node, name, document, projectId })             // tier: 'public'   (projectId required)
createUniversal({ node, name, document })                     // tier: 'universal' (projectId forbidden)
```

Adopters that want to customise the primary / public-tier emit shape
override `HydraniumScopeComputation.exportProject` and `exportPublic`
rather than `addExportedSymbol` directly — the hooks compose cleanly.

## Scope-side vs candidate-side concerns

The framework splits cross-reference handling into two services that
live side-by-side in `langium/scope/`:

- **`HydraniumScopeProvider`** owns *scope and reference resolution* —
  building the layered scope (local + extension + per-tier sub-scopes
  via `getGlobalScope`), resolving a single `ReferenceRequest` to its
  target node (`resolveReference`), and bridging protocol-layer
  source identifiers to Langium `ReferenceInfo`
  (`referenceContextToInfo`).
- **`ReferenceCandidateProvider`** owns the *candidate-side pipeline* —
  taking the scope, applying filter / dedupe / sort, and producing
  `ReferenceCandidate` DTOs for UI dropdowns, GLSP action providers, and
  RPC consumers (`find` / `getCandidateScope`), plus resolving a request
  to its target via the scope provider and building the matched candidate
  (`resolveCandidate`).

**Dependency direction (cycle-free by construction):** candidate
provider → scope provider. The candidate provider reads
`scopeProvider.getScope(...)`, `scopeProvider.referenceContextToInfo(...)`,
`scopeProvider.sortText(...)`, and `scopeProvider.resolveReference(...)`
as primitives. The scope provider never depends on the candidate
provider. `resolveReference` stays on the scope provider with its
`referenceContextToInfo` dependency intact — the two services share that
bridge primitive without forming a cycle.

**LSP completion delegates to the candidate provider.** The
`HydraniumCompletionProvider` (LSP head) overrides
`getReferenceCandidates` to return the candidate provider's
`getCandidateScope(...)` elements, so the text-editor dropdown and the
protocol candidate picker run the SAME filter / canonical-collapse /
name-dedup / sort pipeline once. The completion provider keeps only the
LSP-specific `fillCompletionItem` (`InsertReplaceEdit`) upgrade.

**Adopter override choice:**

- Customising source resolution (synthetic source materialisation,
  semantic-root lookup, by-name lookup) → subclass
  `HydraniumScopeProvider` and override `resolveSyntheticSource` /
  `resolveRootElement` / `resolveElementByName` (or `createGlobalScope`
  for a bypass branch — never `getGlobalScope` itself, which is the
  framework's extension-assembly seam and would hide the scope-extension
  layers behind the override).
- Customising the candidate pipeline (grammar-specific filters,
  display-name shaping, source-info enrichment) → subclass
  `DefaultReferenceCandidateProvider` and override
  `filterCandidate` / `buildCandidate` / `scopedReferenceInfo`.

Both subclassings are independent — adopters subclass one or both as
their grammar requires. A shipping adopter subclasses both (source-resolution
hooks on its `ScopeProvider`; candidate hooks on its
`CandidateProvider`).

**Vocabulary note:** the framework's reference types are named distinctly
from Langium's AST-layer `Reference` / `ReferenceInfo` / `ReferenceDescription`
because they are the *protocol / remote-addressing* mirror of Langium's
in-process query: a `ReferenceSource` (`document` / `element` / `synthetic`)
plus a property — not an AST node in hand. The candidate-framed pipeline
vocabulary (`getCandidateScope`, `filterCandidate`, `CandidateScope`) also
avoids collision with Langium's LSP `CompletionProvider` (cursor-based
all-grammar completion — a different concern).

## Multi-tier emission and the canonical filter

A single AST node is often exported under more than one description so
references can resolve by more than one name form. `HydraniumScopeComputation`
emits an entity at `tier: 'project'` (document-qualified short name) and,
when the owning project qualifies its names, ALSO at `tier: 'public'`
(project-qualified name). This is **multi-tier emission**, and the two
descriptions are **tier siblings** — same node, different tier and name.

### Resolution vs completion — two layers, two jobs

Tier siblings exist for the linker, but should not both surface in a
completion dropdown. The framework keeps these concerns on separate
layers:

- **Resolution scope** (built by `HydraniumScopeProvider.getProjectScope`)
  may legitimately contain several tier siblings of one node, so a
  reference resolves whether the user wrote the short or the qualified
  form. The own-project canonical filter still hides a node's own-project
  public-tier sibling by default (the project-tier short name is
  canonical inside the owning project).
- **Completion** collapses tier siblings to the single most-specific tier
  per node via `applyCanonicalFilter` on `DefaultReferenceCandidateProvider`,
  so a node appears once in a dropdown. The LSP `HydraniumCompletionProvider`
  delegates gathering to that provider, so this is the single owner of the
  collapse. The filter is unconditional; adopters that
  need the raw multi-tier set (introspection UIs) override
  `applyCanonicalFilter` to return its input unchanged.

The primitives backing the filter live in `langium/scope/tier-specificity.ts`:
`areTierSiblings`, `compareTierSpecificity`, `dedupeTierSiblingsStream`.
Tier specificity orders `local` < `project` < `public` < `universal`
(more specific wins); untiered descriptions rank least specific.

### `includeOwnProjectPublic` opt-in

`HydraniumScopeProviderOptions` carries `includeOwnProjectPublic`
(default `false`). When `true`, the own-project canonical filter is
relaxed in the **resolution scope** for public-tier descriptions whose
`projectId` matches the source — so an adopter whose fixtures reference
siblings by the project-qualified form within their own project resolves
those references without
subclassing. Completion still collapses tier siblings, so the opt-in
never doubles dropdown entries. The default `false` keeps the strict
multi-tier emission pattern where the project-tier short name is the
canonical reference inside the owning project.

## Related

- [Element addressing](element-addressing.md) — the four addressing terms and
  the three name-qualification levels the tier axis pairs with.
- [Shared vs per-language DI scope](shared-vs-language-di-scope.md) — which
  module kind the scope services are bound in.
- [Framework vs adopter](framework-vs-adopter.md) — the scoping and completion
  seams, each framework default beside a real override.
