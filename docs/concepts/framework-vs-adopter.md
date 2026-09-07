# Framework defaults vs. adopter customization

Hydranium ships working defaults for scope, naming, visibility, and
completion. An adopter customizes by *subclassing one seam at a time* — the
rest of the machinery keeps working around the override. This doc puts the
framework default and a real adopter customization side by side for the four
scope/naming seams, so a new adopter can see both the out-of-the-box behavior
and the shape of a minimal customization.

**How to read it.** Each seam has a *Framework default* and an *Adopter*
column. The adopter shown is the in-repo multi-grammar example
`examples/order-flow/server` wherever it actually exercises the seam; where it
leaves the default in place, the adopter column describes a generic
customization instead and says so.

**Two things a single-grammar adopter cannot show, and this one can.**

- **A seam is bound per language, not once per server.** `ScopeComputation` is
  bound on all three of this example's languages; `ScopeProvider` on only two.
  Whether a seam is customized is a question per grammar, and "the adopter
  overrides X" is an incomplete sentence.
- **Seam 3 has two unrelated uses.** The framework default is a *tier filter* —
  who may resolve an already-exported symbol. The override below does something
  else entirely: it replaces the candidate set for a **dependent reference**,
  one whose legal targets depend on a previous reference having resolved. Both
  are `ScopeProvider`, and confusing them is easy, so the seam is split into
  3a and 3b.

## Background: the four visibility tiers

Every symbol the framework exports into the global index carries a **tier**
that governs who can resolve it:

| Tier | Meaning | Visible to |
| --- | --- | --- |
| `local` | per-document only | same document (Langium's local scope; never enters the global filter) |
| `project` | project-internal | references originating in the *same* project |
| `public` | cross-project | dependent projects in the visibility closure (hidden from its own project by default) |
| `universal` | workspace-wide | everyone (used for documents with no owning project) |

The tiers are produced at export time (Seam 1), named by the `NameProvider`
(Seam 2), filtered on resolution (Seam 3a), and collapsed to one entry per node
for completion (Seam 4). An adopter usually only needs to touch one of these.

## Seam 1 — Symbol export (what lands in the global index)

`HydraniumScopeComputation.addExportedSymbol` fans a node out to two hooks:

<!-- snippet-skip: override method shown outside its class body -->

```ts
protected override addExportedSymbol(node, exports, document): void {
   this.exportProject(node, exports, document);   // primary
   this.exportPublic(node, exports, document);    // conditional
}
```

- **`exportProject`** (primary emit) pushes one description keyed by
  `getDocumentQualifiedName`, at `tier: 'project'` when the document has an
  owning project, or `tier: 'universal'` when it does not.
- **`exportPublic`** (conditional emit) pushes a second `tier: 'public'`
  description keyed by `getProjectQualifiedName` — **only when the
  project-qualified name differs from the document-qualified one** (i.e. the
  owning project qualifies its names). When the project is unqualified the two
  names are equal, so this second emit is skipped and the node has a single
  description.

So "multi-tier emission" is *one primary (project | universal) plus one
conditional public*, not always two.

| Framework default | Adopter |
| --- | --- |
| Two-name model: short document-qualified name at `project` tier + long project-qualified name at `public` tier, the public emit gated by a **name-shape test** (`projectName !== documentName`). Right for adopters who write cross-project references as `<project>.<element>`. | This example writes them as the bare name — its projects are `UNQUALIFIED_PROJECT_REFERENCE`, so the two names coincide and the default would never emit the public tier at all. It overrides **`exportPublic`** to replace the name-shape test with a **declared-visibility test**: emit the public-tier sibling, at the same document-qualified name, only for declarations the grammar marked `public`. |

<!-- snippet-skip: override method shown outside its class body -->

```ts
// OrderFlowScopeComputation
protected override exportPublic(node, exports, document): void {
   if (!isPubliclyVisible(node)) return;            // the grammar's `public` modifier
   const projectId = this.getProjectIdForDocument(document);
   if (projectId === undefined) return;
   const documentName = this.nameProvider.getDocumentQualifiedName(node);
   if (!documentName) return;
   exports.push(this.descriptions.createPublic({ node, name: documentName, document, projectId }));
}
```

**Why this is the interesting shape.** The framework's default asks a question
about *names*; the override asks one about *what the author declared*. That is
the seam earning its keep — an adopter whose grammar has a visibility modifier
maps it onto the framework's tier here, and everything downstream (resolution
filtering, completion) follows without further work. A declaration that is not
`public` keeps only its `tier: 'project'` description and stays invisible to
other projects, **including in their completion proposals**, because the
candidate provider reads the same filtered scope.

The two emits carry the **same name string** for the **same node**, at two
tiers. Inside the owning project the framework's own-project canonical filter
(Seam 3a) hides the public sibling and the project-tier one answers; from a
dependent project the project-tier one is hidden and the public one answers.
One name, one visible entry either way.

**Extension point.** Override `exportProject` / `exportPublic` (both
`protected`). If you only want to change *names* — not what gets exported —
override the `NameProvider` tier methods (Seam 2) instead; the emission
machinery falls out of the per-emit name comparison automatically.

## Seam 2 — Name production (`NameProvider` tiers)

`DefaultNameProvider` exposes three name tiers, and `getName` (the Langium
linker/scope entry point) returns the project-qualified one by default:

<!-- snippet-skip: method shown outside its class body -->

```ts
getName(node) { return this.getProjectQualifiedName(node); }   // workspace-unique
```

- `getOwnName` — the node's bare name segment.
- `getDocumentQualifiedName` — own name prefixed by named ancestors within the
  document.
- `getProjectQualifiedName` — the document-qualified name prefixed by the
  project's `referenceName`; collapses back to the document-qualified form when
  the project is unqualified.

| Framework default | Adopter (generic — the example uses the default) |
| --- | --- |
| `getName` returns the project-qualified tier (workspace-unique by construction). Name separator and which node properties count as "the name" are set via `NameProviderOptions` (`nameSeparator`, `nameProperties`) at construction — no subclass needed. | Subclass `DefaultNameProvider` and override `getName` to select a different tier (e.g. return `getOwnName` for a grammar whose references are bare), or override an individual tier method. An id-bearing grammar configures `nameProperties: ['id']` instead of subclassing. |

The example does not customize naming, and the reason is worth stating: its
projects are unqualified, so project-qualified already collapses to
document-qualified — which is the name its files actually write. **Reaching for
Seam 2 to fix a cross-project visibility problem is the common wrong turn**; the
example needed Seam 1 instead, because its problem was which tier a symbol was
emitted at, not what it was called.

## Seam 3a — Scope visibility (who can resolve an exported symbol)

`HydraniumScopeProvider` filters the global index per reference by reading each
description's `tier` in `bucketFor`:

- `project` → visible only when the description's project id equals the
  referencing document's project id.
- `public` → **hidden inside its own project** (the own-project canonical
  filter), visible to a *dependent* project only when the description's project
  is in that project's visibility closure.
- `universal` → always visible.
- `local` → never reaches this filter (it lives in Langium's per-document
  scope).

| Framework default | Adopter (generic — the example uses the default) |
| --- | --- |
| Tier-aware filter as above; the `includeOwnProjectPublic` option relaxes the own-project `public` hiding without subclassing. Cross-project visibility is driven by each project's declared `dependencies` (via `ProjectManager`), not by the filter itself. | Override `createGlobalScope` (whole per-context scope) or the tier-walk hooks (`makeScopeContext` / `bucketFor` / `createOwnProjectScope` / `createDependencyScope` / `createUniversalScope` / `chainScopes`). **Do not override `getGlobalScope`** — it is the framework's extension-assembly seam. |

The example changes *visibility* without touching this filter, which is the
intended shape: a folder-scoped `ProjectManager` populates
`Project.dependencies` (feeding the public-tier closure), Seam 1 puts the symbol
at the public tier, and the default filter then does the right thing. A stdlib
seeded through an `AdditionalDocumentContribution` lands at `universal` and
resolves everywhere, again without a filter change.

The observable pair: `commerce-core` declares `public valuetype Money`, which
`orders` resolves; `AuditStamp` is not declared `public`, and a reference to it
from `orders` **must** fail to link. If it ever resolves, the `public` modifier
has stopped meaning anything.

## Seam 3b — Dependent references (candidates that depend on a prior resolution)

The same `ScopeProvider` seam, used for something the tier filter cannot
express. A **dependent reference** is one whose legal targets are determined by
another reference having already resolved — the candidates are not "everything
of this type that is visible", but "the members of *that* node".

Langium's default `getScope` returns the global index filtered by reference
type. For a dependent reference that is too wide, **and it resolves anyway** —
which is the trap, because the happy path keeps working:

| Framework default | Adopter |
| --- | --- |
| `getScope` falls through to the tier-filtered global scope, i.e. every visible node of the reference's type in the workspace. | Override `getScope`, return a narrowed scope for the dependent properties, and **fall through to `super.getScope` for everything else** — the tier filter still governs every other reference in that grammar. |

<!-- snippet-skip: override method shown outside its class body -->

```ts
// OrderFlowLayoutScopeProvider
override getScope(context: ReferenceInfo): Scope {
   if (context.property === 'flowNode' && isDiagramNode(context.container)) {
      return this.createFlowNodeScope(context.container);
   }
   return super.getScope(context);
}
```

Two grammars in this example need it, and **they arrived at it for different
reasons** — which is the part worth internalizing:

- `.process` — `writes Order.status = PAID` is a three-reference chain. Without
  narrowing, `field` admits every `Field` in the workspace, so
  `writes Order.status = SHIPPED` is accepted when `status` is not an
  `OrderStatus`. Here the default scope is too wide in a way that **accepts
  invalid input**.
- `.layout` — `DiagramNode.flowNode` would bind to a same-named `task Approve`
  in an unrelated process and position the wrong element, silently and with no
  diagnostic. Here the default is too wide in a way that **accepts input which
  is valid but means something else**. In a one-process workspace the accidental
  answer is even the right one.

Reading `.ref` inside the override is what drives the chain: it triggers the
linker for the predecessor so the candidate set is computed against a resolved
target. That is safe only because these grammar dependencies are one-way
(`.layout` → `.process` → `.domain`); a cyclic one would not terminate.

`createScopeForNodes` is the framework's re-keyed override of Langium's, so
entries come out under the bare segment the reference text carries. Passing no
`outerScope` is deliberate — it is what makes `Order.nosuchfield` fail rather
than quietly find a same-named field on an unrelated type.

**The general lesson:** a cross-document reference that *resolves* is not the
same as one that is *scoped*. If a reference's meaning depends on another
reference, the default scope will usually still answer — correctly on your
example file, and wrongly on the second one.

## Seam 4 — Completion candidate dedup

A node can appear in the index under more than one tier (Seam 1). For
completion, `DefaultReferenceCandidateProvider.getCandidateScope` collapses
those tier-siblings so a node shows **once** in a dropdown:

<!-- snippet-skip: method shown outside its class body -->

```ts
protected applyCanonicalFilter(candidates) {
   return dedupeTierSiblingsStream(candidates);   // keep the most tier-specific sibling
}
```

Siblings are grouped by node identity and the most tier-specific one is kept
(`local < project < public < universal`). `filterCandidate` is a no-op
pass-through by default — dedup lives in `applyCanonicalFilter`, not the filter
hook. The LSP completion provider (`HydraniumCompletionProvider`) does not
re-implement dedup; it delegates to the same candidate pipeline, so the
dropdown reuses this collapse.

| Framework default | Adopter (generic — the example uses the default) |
| --- | --- |
| One candidate per node, most-specific tier wins; `filterCandidate` accepts everything. | Subclass `DefaultReferenceCandidateProvider` and override `applyCanonicalFilter` (to keep the raw multi-tier set), `filterCandidate` (grammar-specific accept/reject), or `buildCandidate` (label/value shaping). |

The example does not customize completion — and gets the Seam-1 visibility rule
in its dropdowns for free, because the candidate provider reads the same
filtered scope the linker does.

## Which seams does the reference adopter exercise?

| Seam | Framework default | `order-flow` |
| --- | --- | --- |
| 1 — symbol export | `exportProject` + conditional `exportPublic`, gated on name shape | **overrides `exportPublic`** on all three languages — gated on the grammar's `public` modifier instead |
| 2 — name production | `getName` = project-qualified | default (projects are unqualified, so it already collapses to what the files write) |
| 3a — scope visibility | tier-aware filter + project dependencies | default (drives visibility via `ProjectManager.dependencies` + Seam 1) |
| 3b — dependent references | falls through to the tier-filtered global scope | **overrides `getScope`** on `.process` and `.layout`; `.domain` keeps the default, having no dependent references |
| 4 — completion dedup | one candidate per node, most-specific tier | default |

This is the intended adoption shape: **customize the minimum, inherit the
machinery.** Two seams are touched, each for a reason the framework cannot
guess — what *this grammar* means by "public", and which references are
dependent — and tier-aware naming, cross-project visibility and completion dedup
all come from the defaults.

Note the two are touched at different granularity: Seam 1 is bound on every
language so one visibility rule governs the workspace, while Seam 3b is bound
only where a grammar actually has a dependent reference. Binding a seam you do
not need costs nothing at runtime but hides which grammar the behaviour belongs
to.

## Why there is no seam for composing services

Every seam above is a service slot you rebind or a method you override. There is
deliberately **no framework helper wrapping Langium's `inject(...)`** — no
factory taking per-slot hook callbacks, no builder over the module chain. Plain
composition is the whole API:

<!-- snippet-skip: a one-line composition sketch, its four modules unbound -->

```ts
const services = inject(defaults, generated, framework, mine);
```

A hook-callback factory was tried and removed. It cost three things a wrapper
over a native idiom generally costs. The hooks' return types were the
framework's *base* service types, so they widened over an adopter's narrowed
subclass and adopters bypassed the hook for the module pass-through anyway. Only
some slots got hooks, with no principled rule for which. And `inject()`'s
ordering — the thing that actually decides which binding wins — disappeared
behind generic parameters and casts, to save about six lines per consumer.

**The rule that generalises:** when a framework helper would only wrap a Langium
idiom, don't write it. Readers already know `inject`, and a second layer is
another thing to learn. Reach for an abstraction when it removes a real
foot-gun — a silent ordering bug, a type narrowing that gets lost — not for
surface-area reduction alone. The same reasoning is why class-based composition
with `protected createXxx()` hooks is not used either: a DI slot override
already cascades, and layering classes over it doubles up without adding power.
