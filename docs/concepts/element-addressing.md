# Element addressing — name, reference name, key, id

Four terms name the ways an element can be *addressed* — spelled, referenced,
identified — and only four. They are worth learning as a set, because two of
the axes have members spelled identically and the framework relies on the
words to keep them apart.

This page is the vocabulary. What the framework *does* with an address —
which slice of the index it lands in, and who can see it — is
[Scope and visibility](scope-and-visibility.md).

How an element is *addressed* — spelled, referenced, identified — uses
four terms, and only four.

| Term | Means | Owner |
| --- | --- | --- |
| **name** (three *qualification levels*) | how an element is spelled: own → document-qualified → project-qualified | `NameProvider` |
| **reference name** | a name chosen so it resolves *from a given source* | `ReferenceBuilder` |
| **key** | rename-stable handle **within one document** | `ElementKeyProvider` |
| **id** | identifies projects, clients, languages, sessions — **never elements** | various |

Two rules follow:

1. **`tier` is reserved for the visibility axis.** The spelling axis is
   **qualification level**. Never write "tier" for how a name is spelled
   — the two axes both have members called `local` and `project`, which
   is exactly why they need separate words. ("Name scope" was rejected:
   "scope" is the most overloaded word in a Langium codebase.)
2. **Elements are addressed by name or by key.** Ids identify projects,
   clients, languages and sessions. This does *not* retire "id" —
   `Project.id`, `clientId`, `languageId` and the GLSP wire ids all
   stay. What goes away is "id" as a way to address an AST element.

**Reference name is not a fourth qualification level.** It is a *policy
over* the levels — document-qualified within a project, project-qualified
across one — plus source-grammar escaping. It also answers "not visible
from here" with `undefined`, which no qualification level does.

Consequences worth knowing before you reach for one:

- A **name** is not rename-stable. `ElementSource.name` (the wire shape a
  form editor or diagram sends) is a qualified name; rename the element
  and the address changes. Callers holding an address across an edit
  re-derive it.
- A **key** is rename-stable but only round-trips *within its document* —
  `ElementKeyProvider.getElementKey`'s inverse takes a context node that
  defines the resolution scope. There is deliberately **no** framework
  identifier that is both workspace-wide and rename-stable; nothing has
  asked for one, and inventing it means maintaining a second identity
  index beside the name index.

The two `Reference*` producers are easy to conflate, so:
`ReferenceBuilder.getReferenceName` **mints** the name for a *new*
reference (visibility-aware, source-relative);
`AbstractSerializer.serializeReferenceText` **renders** a reference that
*already exists* (reads `$refText`).

## Related

- [Scope and visibility](scope-and-visibility.md) — the tier axis these names
  are filtered on, and how a query sees them.
- [Framework vs adopter](framework-vs-adopter.md) — the `NameProvider` and
  `ElementKeyProvider` seams, with a framework default beside an override.
