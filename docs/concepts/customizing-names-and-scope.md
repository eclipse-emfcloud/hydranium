# Customizing names, scope and visibility

How the framework decides what an element is called, what it can see, and
what can see it, and the four seams where a language changes that. The
defaults work out of the box. You customize one seam at a time, by subclassing
one service, and everything downstream follows.

The worked example throughout is
[`examples/order-flow/server`](../../examples/order-flow/server): three grammars
that reference each other across projects. Seams are bound per language, so
"the adopter overrides the scope provider" is an incomplete sentence: order-flow
binds its own `ScopeComputation` on all three of its languages, and its own
`ScopeProvider` on two.

## Addressing an element

Four terms name the ways an element is addressed, and only four:

| Term | Means | Owner |
| --- | --- | --- |
| **name**, at three _qualification levels_ | how an element is spelled: own → document-qualified → project-qualified | `NameProvider` |
| **reference name** | a name chosen so it resolves _from a given place_ | `ReferenceBuilder` |
| **key** | a handle that survives a rename, **within one document** | `ElementKeyProvider` |
| **id** | identifies projects, clients, languages and sessions, **never elements** | various |

- **"Tier" belongs to visibility, below; a name has a qualification level.**
  Both axes have members called `local` and `project`, which is why they need
  separate words.
- **A name does not survive a rename.** The address a form or a diagram sends
  is a qualified name, so a caller holding one across an edit derives it again.
- **A key survives a rename, but only within its document.** No identifier is
  both workspace-wide and rename-stable.
- **Minting is not rendering.** `ReferenceBuilder.getReferenceName` chooses the
  name for a _new_ reference, from where it will be written;
  `AbstractSerializer.serializeReferenceText` renders a reference that already
  exists, as its text was written.

## Tier, name and scope

Three separate things decide whether a reference resolves:

1. **Tier**: each exported description carries a visibility class, `local`,
   `project`, `public` or `universal`, which decides who may resolve it.
2. **Name**: the key the description is found by, at one of the three
   qualification levels.
3. **Scope**: what one reference, at one place, can see: the index filtered by
   tier for that place. The framework builds it inner-first: the document's own
   elements, then its project's, then those of the projects it depends on, then
   everything universal.

A tier is a label on a description; a scope is the answer to one query.

| Tier | Meaning | Visible to |
| --- | --- | --- |
| `local` | per-document | the same document only; it never enters the global index |
| `project` | project-internal | references from the _same_ project |
| `public` | across projects | projects that depend on its project, and hidden inside its own project, where its `project` sibling answers |
| `universal` | workspace-wide | everyone; for documents that belong to no project |

As a rough guide from object-oriented languages: `local` is private, `project`
is package-private, `public` is public but only to declared dependents, and
`universal` is built in.

## Seam 1: what a declaration exports

`HydraniumScopeComputation.addExportedSymbol` exports a declaration through two
hooks:

<!-- snippet-skip: override method shown outside its class body -->

```ts
protected override addExportedSymbol(node, exports, document): void {
   this.exportProject(node, exports, document);   // primary
   this.exportPublic(node, exports, document);    // conditional
}
```

- **`exportProject`** exports it under its document-qualified name, at the
  `project` tier, or at `universal` when the document has no project.
- **`exportPublic`** exports it a second time, at the `public` tier under its
  project-qualified name, but only when that name differs from the
  document-qualified one, that is, when the project qualifies its names.

The two exports of one node are **tier siblings**. Each export uses one of the
typed factories on `HydraniumAstNodeDescriptionProvider`, which reject a
description with the wrong project information at compile time:

<!-- snippet-skip: tier-factory signatures listed bare, not calls against a provider -->

```ts
createLocal({ node, name, document })                         // tier: 'local'
createProject({ node, name, document, projectId })            // tier: 'project'  (projectId required)
createPublic({ node, name, document, projectId })             // tier: 'public'   (projectId required)
createUniversal({ node, name, document })                     // tier: 'universal' (projectId forbidden)
```

| Framework default | order-flow |
| --- | --- |
| A `public` export under the project-qualified name, decided by the **shape of the names**. Right for a language whose cross-project references are written `<project>.<element>`. | Its references are written as bare names, so the two names coincide and the default would never export `public` at all. It overrides **`exportPublic`** to decide by **what the author declared**: it exports a `public` sibling, under the same name, for declarations the grammar marks `public`. |

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

This is the seam for a grammar with a visibility modifier: map the modifier
onto the tier here, and resolution and completion follow with no further work.
A declaration that is not `public` keeps only its `project` export and stays
invisible to other projects, in their completion proposals too.

Override `exportProject` and `exportPublic` rather than `addExportedSymbol`. To
change only what things are _called_, use Seam 2 instead.

## Seam 2: what a declaration is called

`DefaultNameProvider` computes the three qualification levels:

- `getOwnName`: the node's own name;
- `getDocumentQualifiedName`: the own name prefixed by its named ancestors in
  the document;
- `getProjectQualifiedName`: the document-qualified name prefixed by the
  project's reference name, or the document-qualified name when the project
  does not qualify its names.

`getName`, which Langium's linker and scopes use, returns the project-qualified
one.

| Framework default | Customizing it |
| --- | --- |
| `getName` returns the project-qualified name. The separator and which properties count as the name are options, `nameSeparator` and `nameProperties` in `NameProviderOptions`, so a grammar whose elements carry an `id` sets `nameProperties: ['id']` rather than subclassing. | Subclass `DefaultNameProvider` and override `getName` to pick another level, for a grammar whose references are bare, or override one of the level methods. order-flow keeps the default: its projects do not qualify names, so the project-qualified name already is what its files write. |

**Reaching for naming to fix a visibility problem is the common wrong turn.** If
a symbol cannot be seen from another project, the question is which tier it was
exported at, Seam 1, not what it is called.

## Seam 3a: who can resolve a symbol

`HydraniumScopeProvider` filters the global index for each reference by tier:

- `project`: visible only from the same project;
- `public`: visible from a project that depends on its project, directly or
  through others, and hidden inside its own project;
- `universal`: always visible;
- `local`: never reaches this filter; it lives in the document's own scope.

| Framework default | Customizing it |
| --- | --- |
| The filter above. Which projects a project can see comes from the `dependencies` its `ProjectManager` declares, not from the filter. `includeOwnProjectPublic` in `HydraniumScopeProviderOptions` makes a project's own `public` exports resolvable inside it too, for a language that references its own elements by their project-qualified name. | Override `createGlobalScope`, or the hooks it walks (`makeScopeContext`, `bucketFor`, `createOwnProjectScope`, `createDependencyScope`, `createUniversalScope`, `chainScopes`). To change how a reference's source is found, override `resolveSyntheticSource`, `resolveRootElement` or `resolveElementByName`. **Never override `getGlobalScope`**: it is where the framework adds scope extensions, and an override hides them. |

order-flow changes visibility without touching this filter, which is the
intended shape: its folder-based `ProjectManager` declares each project's
dependencies, Seam 1 exports the symbol at the `public` tier, and the default
filter does the rest. A
[standard library](../guides/ship-a-standard-library.md) added through an
`AdditionalDocumentContribution` lands at `universal` and resolves everywhere,
again without a filter change.

The pair to test it with: `commerce-core` declares `public valuetype Money`,
which `orders` resolves; `AuditStamp` is not declared `public`, and a reference
to it from `orders` **must** fail to link. If it ever resolves, `public` has
stopped meaning anything.

## Seam 3b: references that depend on another reference

The same `ScopeProvider`, for something the tier filter cannot express. A
**dependent reference** is one whose legal targets depend on another reference
having resolved first: not "everything of this type that is visible", but "the
members of _that_ node". Langium's default scope offers every visible node of
the reference's type, which is too wide, **and resolves anyway**. That is the
trap: the happy path keeps working.

| Framework default | Customizing it |
| --- | --- |
| `getScope` returns the tier-filtered global scope: every visible node of the reference's type. | Override `getScope`, return a narrowed scope for the dependent properties, and **fall through to `super.getScope` for everything else**, so the tier filter still governs the grammar's other references. |

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

Two order-flow grammars need it, for different reasons:

- **`.process`**: `writes Order.status = PAID` is a chain of three references.
  Without narrowing, `status` would admit every field in the workspace, so
  `writes Order.status = SHIPPED` would be accepted where `status` is not an
  `OrderStatus`. Too wide here **accepts invalid input**.
- **`.layout`**: a diagram node's `flowNode` would bind to a same-named task in
  an unrelated process and position the wrong element, with no diagnostic. Too
  wide here **accepts input that is valid but means something else**.

Reading the previous reference's `.ref` inside the override resolves it first,
so the candidates are computed against a resolved target. That is safe only
because these references depend one way (`.layout` → `.process` → `.domain`);
a cycle would not terminate. `createScopeForNodes`, called with no outer scope,
is what makes `Order.nosuchfield` fail rather than find a same-named field on
an unrelated type.

**A reference that resolves is not the same as one that is scoped.** If a
reference's meaning depends on another, the default scope will usually still
answer: correctly on your first example file, and wrongly on the second.

## Seam 4: completion

A node exported at two tiers would appear twice in a completion list.
`DefaultReferenceCandidateProvider` collapses tier siblings to the most specific
one, in `applyCanonicalFilter`. The text editor's completion and the candidate
lists of forms and diagrams all use this provider, so they agree.

| Framework default | Customizing it |
| --- | --- |
| One candidate per node, the most specific tier winning; `filterCandidate` accepts everything. | Subclass `DefaultReferenceCandidateProvider` and override `applyCanonicalFilter` to keep every tier, `filterCandidate` to accept or reject by your grammar's rules, `buildCandidate` to shape labels and values, or `scopedReferenceInfo` to enrich the source a query starts from. |

order-flow keeps the default, and its completion lists follow Seam 1's
visibility rule for free, because the candidate provider reads the same
filtered scope the linker does.

## What order-flow customizes

| Seam | Framework default | order-flow |
| --- | --- | --- |
| 1: export | `project` export, plus a `public` one decided by name shape | **overrides `exportPublic`** on all three languages, decided by the grammar's `public` modifier |
| 2: naming | `getName` is project-qualified | default; its projects do not qualify names |
| 3a: visibility | tier filter over the projects' declared dependencies | default; its `ProjectManager` declares the dependencies |
| 3b: dependent references | every visible node of the type | **overrides `getScope`** on `.process` and `.layout`; `.domain` has no dependent references |
| 4: completion | one candidate per node | default |

**Customize the minimum and inherit the rest.** Two seams are touched, each for
something the framework cannot know: what this grammar means by `public`, and
which of its references depend on another. Seam 1 is bound on every language,
so one visibility rule governs the workspace; Seam 3b only where a grammar has
a dependent reference, so the binding says which grammar the behaviour belongs
to.
