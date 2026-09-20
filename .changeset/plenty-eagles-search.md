---
'@hydranium/core': patch
---

`NameProvider.findNextName` now resolves its `type` argument through the AST
type hierarchy, so a supertype names the uniqueness scope its concrete types
share — the shape a cross-reference targeting that supertype produces. It
previously filtered on `$type` equality, where a supertype matched no node,
produced an empty collision set and returned the proposal unchanged, which a
caller cannot tell from a name that was genuinely free. The two qualified
variants already resolved `type` this way through `IndexManager.allElements`,
so the tiers no longer disagree about what one type argument means. A call
passing a concrete type with no subtypes is unaffected.
