---
paths:
  - "packages/core/src/langium/scope/**"
  - "packages/core/src/langium/project/**"
  - "packages/core/test/langium/scope/**"
---

# Scope

`HydraniumScopeProvider.getProjectScope` returns the global scope unfiltered
when the source document has no owning project or
`ProjectManager.isSingleProject()` is true. The bound default,
`SingleProjectManager`, always reports true, so on a default bundle the
`project` and `public` tiers restrict nothing, and a tier-filter test written
against one never runs the filter it means to test.

Test the filter on `makeTestServices({ seedProjects })` with at least two
projects, and give the source document an owner with
`bundle.projectManager.ownUri`: the stub reports a single project while it
holds one or none, and owns no URI until told to
([Seam 3a](../../docs/concepts/customizing-names-and-scope.md#seam-3a-who-can-resolve-a-symbol)).
