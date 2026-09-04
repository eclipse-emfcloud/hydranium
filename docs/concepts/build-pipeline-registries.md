# Build-pipeline registries

The framework wires build-time work into Langium's document-build pipeline
through a small family of priority-ordered registries, all driven from one
place — `BuildPipelineIntegration` (the single shared service that subscribes to
the builder's phase notifications). Feature services stay pure registries with
no listener lifecycle of their own.

## The granularity grid

Langium's `DocumentBuilder` exposes exactly two phase-notification
granularities; the framework adds a node-level walk on top of them. That yields
a 2×2 of (granularity × trigger):

| | `onDocumentPhase` (per document) | `onBuildPhase` (whole batch) |
|---|---|---|
| **per node** | `AstExtension` (`AstExtensionService`) | `IntegrityRule` (`IntegrityService`) |
| **whole unit** | — (no registry; see below) | `BuildPhasePass` (`BuildPhasePassService`) |

- **`AstExtension`** — node-level enrichment (computed / synthetic properties),
  dispatched per document via `extendNode` / `extendDocument`.
- **`IntegrityRule`** — node-level AST corrections that may mutate + reparse,
  dispatched once per build (the batch must settle before a mutation reparses).
- **`BuildPhasePass`** — whole-batch work at a build phase (`run(documents)`),
  the `onBuildPhase` sibling of `AstExtension`. It rides Langium's native
  `onBuildPhase` signature directly and owns its own walk — for work needing
  cross-document ordering (e.g. parent-first inheritance resolution) that a
  per-node walk cannot express.

The empty cell — whole-*document* work at a document phase — has no registry
because nothing needs it yet. Adopters wanting per-document (non-node)
derivation fake it with a root-only `nodeFilter` on an `AstExtension`.

## Why integrity and inheritance are passes, not extensions

Both run once per build (`onBuildPhase`) because they need the batch settled:
integrity mutates + reparses; an inheritance pass resolves each element's
inherited members in topological (parent-first) order across documents. A per-node `onDocumentPhase` walk gives
no cross-document ordering guarantee, so neither fits `AstExtension`.

Putting framework integrity and adopter passes in one registry is the point:
they share a single priority space, so the order between them is *declared*, not
left to DI construction order.

## Priority bands

`BuildPhasePass.priority` defaults to `0` (ascending; ties break by registration
order). The framework reserves **negative** priorities for *foundational* passes
that must precede adopter work regardless of registration order — notably
integrity (`INTEGRITY_PASS_PRIORITY`), which cleans the AST every derived-state
pass reads. Adopters therefore use `0` or higher:

- framework foundational (integrity): negative band
- adopter passes: `0`+ (a derived-state pass naturally runs after the
  foundational band); chained adopter passes order among themselves with
  increasing values (e.g. an inheritance pass at `100` → synthetic-attribute
  reprojection at `200`)

The negative band is load-bearing: an adopter pass registered with no explicit
priority is `0`, and adopter contributions register *before* the framework
integrity pass (contribution-group construction precedes
`BuildPipelineIntegration`'s constructor), so a `0`-vs-`0` tie would let the
adopter run before integrity. The negative band removes that footgun.

## What does NOT go through these registries

Two categories of direct phase-listener are deliberately outside the registries:

- **Builder self-plumbing** — `DocumentBuilder`'s own `awaitDocumentState`
  (resolve-when-reached + orphan re-queue) and per-phase logging. The builder
  fires the events the registries consume; it cannot dispatch itself through
  them.
- **Egress / reactions** — `ModelService` client sync, `DataServer` subscription
  dispatch, `AstDocumentManager` reactions. These consume *settled* state and
  emit it outward (to the LSP client / RPC subscribers); they are not processing
  passes, are phase-separated, and are order-independent, so a pass registry
  would be the wrong home.
