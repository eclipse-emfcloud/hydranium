---
'@hydranium/protocol': minor
'@hydranium/core': minor
'@hydranium/data-server': minor
---

Every type named by a `protected` member is now importable from its package's
entry point. The framework's extensibility model is subclassing, so a
`protected` signature is part of the surface an adopter binds to — and a
subclass cannot state the type of a member it overrides when that type is
unexported, leaving `import('…/internal/path')` or a structural restatement as
the only options. A new `check:protected-signatures` gate keeps it that way,
asserting that every type reachable through a subclass-visible member of the
ten packages resolves from their entry points.
