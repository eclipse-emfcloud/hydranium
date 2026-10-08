# Build pipeline

How the framework wires build-time work into Langium's document build, and why.
Which registry an adopter's work goes in, and the priorities it uses, are in
[Customizing services](../../concepts/customizing-services.md#which-registry-build-work-goes-in).

## One integration, pure registries

Every registry is driven from one place, `BuildPipelineIntegration`, the single
shared service that subscribes to the builder's phase notifications. The
feature services stay pure registries with no listener lifecycle of their own.

Langium's `DocumentBuilder` notifies at two granularities, `onDocumentPhase`
per document and `onBuildPhase` per batch; the framework adds a node-level walk
on top. `AstExtension` rides the first, `IntegrityRule` and `BuildPhasePass`
the second. The whole-document cell at a document phase has no registry
because nothing needs it.

## Why integrity and inheritance are passes, not extensions

Both run once per build (`onBuildPhase`) because they need the batch settled:
integrity mutates and reparses; an inheritance pass resolves each element's
inherited members in topological (parent-first) order across documents. A
per-node `onDocumentPhase` walk gives no cross-document ordering guarantee, so
neither fits `AstExtension`.

Putting framework integrity and adopter passes in one registry is the point:
they share a single priority space, so the order between them is _declared_,
not left to DI construction order.

## The negative priority band

What the framework's negative band holds is decided by a rule rather than by a
list: a pass belongs in it when the rest of its phase reads what that pass
produced. Integrity qualifies because it cleans the AST every derived-state
pass then walks.

The band is load-bearing: an adopter pass registered with no explicit priority
is `0`, and adopter contributions register _before_ the framework's own passes
(contribution-group construction precedes `BuildPipelineIntegration`'s
constructor), so a `0`-vs-`0` tie would let the adopter run first. The negative
band removes that footgun.

## What does not go through the registries

Two categories of direct phase listener are deliberately outside them:

- **Builder self-plumbing**: `DocumentBuilder`'s own `awaitDocumentState`
  (resolve-when-reached and orphan re-queue) and per-phase logging. The builder
  fires the events the registries consume; it cannot dispatch itself through
  them.
- **Egress and reactions**: `ModelService` client sync, `DataServer`
  subscription dispatch, `AstDocumentManager` reactions. These consume
  _settled_ state and emit it outward, to the LSP client or RPC subscribers;
  they are not processing passes, are phase-separated, and are
  order-independent, so a pass registry would be the wrong home.
