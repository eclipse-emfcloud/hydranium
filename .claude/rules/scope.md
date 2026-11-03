---
paths:
  - "packages/core/src/langium/scope/**"
  - "packages/core/src/langium/project/**"
  - "packages/core/test/langium/scope/**"
---

# Scope

`DefaultHydraniumScopeProvider.getProjectScope` returns the global scope
unfiltered when the source document has no owning project or
`ProjectManager.isSingleProject()` is true.

<!-- guidance-claim: scope-single-project test=packages/core/test/langium/project/single-project-manager.test.ts -->

The bound default, `SingleProjectManager`, always reports true, so on a
default bundle the `project` and `public` tiers restrict nothing, and a
tier-filter test written against one never runs the filter it means to test.

<!-- guidance-claim: scope-stub-threshold test=packages/core/test/testing/stub-project-manager.test.ts -->
<!-- guidance-claim: scope-stub-ownership test=packages/core/test/testing/stub-project-manager.test.ts -->

Test the filter on `makeTestServices({ seedProjects })` with at least two
projects, and give the source document an owner with
`bundle.projectManager.ownUri`: the stub reports a single project while it
holds one or none, and owns no URI until told to
([Seam 3a](../../docs/concepts/customizing-names-and-scope.md#seam-3a-who-can-resolve-a-symbol)).
