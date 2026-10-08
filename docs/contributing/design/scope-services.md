# Scope and candidate services

How the framework splits reference handling between two services, and why. The
adopter's view, the tiers and the four seams, is in
[Customizing names, scope and visibility](../../concepts/customizing-names-and-scope.md).

## Two services, one direction

Both live in `core/src/langium/scope/`:

- **`HydraniumScopeProvider`** owns scope and reference resolution: it builds
  the layered scope (`getGlobalScope`), resolves one `ReferenceRequest` to its
  target (`resolveReference`), and bridges protocol-level sources to Langium's
  `ReferenceInfo` (`referenceContextToInfo`).
- **`ReferenceCandidateProvider`** owns the candidate pipeline: it takes the
  scope, filters, collapses tier siblings, sorts, and produces
  `ReferenceCandidate` objects for dropdowns, GLSP action providers and RPC
  callers (`find`, `getCandidateScope`), and resolves a request to its matched
  candidate (`resolveCandidate`).

The candidate provider depends on the scope provider, never the other way: it
uses `getScope`, `referenceContextToInfo`, `sortText` and `resolveReference` as
primitives. `resolveReference` stays on the scope provider with its
`referenceContextToInfo` dependency, so the two share that bridge without a
cycle.

The LSP head's `HydraniumCompletionProvider` overrides `getReferenceCandidates`
to return the candidate provider's `getCandidateScope(...)` elements, so the
text editor's dropdown and the protocol's candidate picker run the same
pipeline once. The completion provider keeps only the LSP-specific
`fillCompletionItem` upgrade to an `InsertReplaceEdit`.

## The chain

The default scope is built inner-first: the document's local scope,
`extension:local`, the own project, its dependencies, the universal index, and
`extension:universal` outermost. The two extension layers sit at different
positions, which is why `getGlobalScope`, where they are assembled, is not an
adopter seam.

Resolution may contain several tier siblings of one node, so a reference
resolves whether its text is the short or the qualified form; only completion
collapses them. The ordering behind the collapse lives in
`scope/tier-specificity.ts` (`areTierSiblings`, `compareTierSpecificity`,
`dedupeTierSiblingsStream`): `local` < `project` < `public` < `universal`, with
an untiered description least specific.

## Vocabulary

The framework's reference types are named apart from Langium's `Reference`,
`ReferenceInfo` and `ReferenceDescription` because they are the protocol mirror
of Langium's in-process query: a `ReferenceSource` (`document`, `element` or
`synthetic`) plus a property, not an AST node in hand. The candidate vocabulary
(`getCandidateScope`, `filterCandidate`, `CandidateScope`) also stays clear of
Langium's LSP `CompletionProvider`, which is cursor-based completion for every
grammar, a different concern.
