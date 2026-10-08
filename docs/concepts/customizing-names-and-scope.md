# Customizing names, scope and visibility

This page covers how your language decides what an element is called, which
references can find it, and what shows up in completion. The defaults work
without any code. When you need a different rule, you subclass one service,
and resolution, completion, forms and diagrams all follow it.

The worked example is
[`examples/order-flow/server`](../../examples/order-flow/server): three grammars
that reference each other across projects. You bind these services per
language. order-flow binds its own `ScopeComputation` on all three languages,
and its own `ScopeProvider` on two of them.

## Addressing an element

You will meet four terms:

- **Name.** How an element is spelled, at one of three qualification levels:
  its own name, the document-qualified name (prefixed by its named ancestors),
  and the project-qualified name (prefixed by the project). `NameProvider`
  computes them.
- **Reference name.** The name to write so a reference resolves from a given
  place. `ReferenceBuilder.getReferenceName` chooses it for a _new_ reference;
  `AbstractSerializer.serializeReferenceText` renders a reference that already
  exists, as it was written.
- **Key.** A handle from `ElementKeyProvider` that survives a rename, but only
  within one document.
- **Id.** Identifies projects, clients, languages and sessions, never
  elements.

A name does not survive a rename. Forms and diagrams address an element by its
qualified name, so if you hold one across an edit, derive it again.

## Tier, name and scope

Three things decide whether a reference resolves:

1. **Tier**: each exported description carries a visibility tier, which
   decides who may resolve it.
2. **Name**: the key the description is found by.
3. **Scope**: what one reference can see from where it is written. The
   framework builds it inner-first: the document's own elements, then its
   project's, then those of the projects it depends on, then everything
   universal.

You choose the tier when you export a declaration (Seam 1):

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

The two exports of one node are **tier siblings**. To create an export, use the
factory for its tier on `HydraniumAstNodeDescriptionProvider`, such as
`createPublic`. Each factory rejects the wrong project information at compile
time.

The default suits a language whose cross-project references are written
`<project>.<element>`. If your references are bare names, the two names
coincide and the default never exports `public`. order-flow is such a
language, so it overrides `exportPublic` to export a `public` sibling, under
the same name, for declarations the grammar marks `public`:

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

If your grammar has a visibility modifier, map it onto the tier here.
Resolution and completion follow with no further work. A declaration that is
not `public` keeps only its `project` export, so other projects cannot see it,
in their completion lists either.

Override `exportProject` and `exportPublic`, not `addExportedSymbol`. To change
only what things are _called_, use Seam 2.

## Seam 2: what a declaration is called

`DefaultNameProvider` computes the three name levels. `getName`, which
Langium's linker and scopes use, returns the project-qualified one.

- If your grammar names elements by another property, set `nameProperties` in
  `NameProviderOptions`, for example `nameProperties: ['id']`. The separator
  is the `nameSeparator` option.
- To pick another level, subclass `DefaultNameProvider` and override `getName`
  or one of the level methods.

order-flow keeps the default: its projects do not qualify names, so the
project-qualified name is already what its files write.

**If a symbol cannot be seen from another project, do not change its name.**
Check which tier it was exported at, in Seam 1.

## Seam 3a: who can resolve a symbol

`HydraniumScopeProvider` filters the global index for each reference by the
tiers in the table above. You control which projects a project can see through
the `dependencies` your `ProjectManager` declares; dependencies of dependencies
count too.

order-flow changes visibility without touching this filter, and you usually
can too: its folder-based `ProjectManager` declares each project's
dependencies, Seam 1 exports the symbol at the `public` tier, and the default
filter does the rest. A
[standard library](../guides/ship-a-standard-library.md) added through an
`AdditionalDocumentContribution` lands at `universal` and resolves everywhere,
again without a filter change.

To test it, use a pair: `commerce-core` declares `public valuetype Money`,
which `orders` resolves; `AuditStamp` is not declared `public`, and a reference
to it from `orders` **must** fail to link. If it ever resolves, `public` has
stopped meaning anything.

If your language references its own elements by their project-qualified name,
set `includeOwnProjectPublic` in `HydraniumScopeProviderOptions`. To change the
filter itself, override `createGlobalScope`. **Never override
`getGlobalScope`**: the framework adds scope extensions there, and an override
hides them.

## Seam 3b: references that depend on another reference

A **dependent reference** is one whose legal targets depend on another
reference having resolved first: not "everything of this type that is
visible", but "the members of _that_ node". The default scope offers every
visible node of the reference's type, which is too wide, **and resolves
anyway**. That is the trap: the happy path keeps working.

Override `getScope` on your `ScopeProvider`, return a narrowed scope for the
dependent properties, and **fall through to `super.getScope` for everything
else**, so the tier filter still governs the grammar's other references:

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
so you compute the candidates against a resolved target. This is safe only if
your references depend one way (`.layout` → `.process` → `.domain`); a cycle
would not terminate. Build the narrowed scope with `createScopeForNodes` and no
outer scope, so that `Order.nosuchfield` fails rather than finds a same-named
field on an unrelated type.

**A reference that resolves is not the same as one that is scoped.** If a
reference's meaning depends on another, the default scope will usually still
answer: correctly on your first example file, and wrongly on the second.

## Seam 4: completion

Text completion and the candidate lists of forms and diagrams come from the
`references.CandidateProvider` slot. It shows one entry per node, even for a
node exported at two tiers. To filter candidates or shape their labels,
subclass `DefaultReferenceCandidateProvider`. order-flow keeps the default.

## What order-flow customizes

| Seam | Framework default | order-flow |
| --- | --- | --- |
| 1: export | `project` export, plus a `public` one decided by name shape | **overrides `exportPublic`** on all three languages, decided by the grammar's `public` modifier |
| 2: naming | `getName` is project-qualified | default; its projects do not qualify names |
| 3a: visibility | tier filter over the projects' declared dependencies | default; its `ProjectManager` declares the dependencies |
| 3b: dependent references | every visible node of the type | **overrides `getScope`** on `.process` and `.layout`; `.domain` has no dependent references |
| 4: completion | one candidate per node | default |

**Customize the minimum and inherit the rest.** order-flow touches two seams,
each for something the framework cannot know: what this grammar means by
`public`, and which of its references depend on another. It binds Seam 1 on
every language, so one visibility rule governs the workspace. It binds
Seam 3b only where a grammar has a dependent reference, so the binding shows
which grammar the behaviour belongs to.
