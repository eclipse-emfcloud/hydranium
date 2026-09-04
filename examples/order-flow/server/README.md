# order-flow — the framework's multi-grammar example server

Order fulfillment, split into three grammars with deliberately asymmetric head
affinity:

- **`*.domain`** — entities, value types, enumerations, typed fields.
  Structural, refactor-heavy, diff-friendly: text is the better editor.
- **`*.process`** — tasks, gateways, transitions over a domain entity.
  Behavioural: a flow is better edited as a graph, and topology errors that
  are invisible in text are obvious in a diagram.
- **`*.layout`** — node bounds for a process, in the `layout` grammar. Purely
  additive: a `.process` with no `.layout` file is still complete, which is
  the state of every hand-authored process before a diagram first opens it.

References point ONE way down the chain: `.layout` depends on `.process`
depends on `.domain`, never the reverse.

The seam the example exists for is a single line of `.process`:

```
task Pay writes Order.status = PAID
```

Three cross-references, each scoped by the previous one — an entity, then a
field of *that* entity, then a literal of the enumeration *that field* is
typed with. Rename `OrderStatus.PAID` in `.domain` and the `.process` file
follows; retype the field and the assignment stops linking.

Models live in [`../workspace`](../workspace), which
also carries the two-project visibility demonstration and its negative
fixture.

## Why multiple grammars matter to the framework

`AstReflection` is a **single shared slot**, so all three grammars must come
from ONE `langium-cli` run over one `langium-config.json`. Independently
generated language packages each bind that slot and the last one wins,
leaving the other grammar's types unknown to reflection —
`assertReflectionCoversLanguages` fails the boot rather than letting that pass
silently. `test/composition.test.ts` pins the supported shape.

This is also the in-repo adopter that exercises the multi-grammar composition
path with real grammars, real parsers and real reflection — which is how it
earns its keep: standing the composition up against three real grammars is
what surfaces framework defects that a single-grammar example cannot reach.

## How this directory was built

Step 1 is a real command:

```bash
hydranium-cli init examples/order-flow/server --name OrderFlow \
  --grammar Domain --grammar Process --grammar Layout --monorepo
```

`--name` is the project — it drives `OrderFlowAstReflection` and
`OrderFlowGeneratedSharedModule`, one set per project. Each `--grammar` is one
language, driving its own `<Grammar>GeneratedModule` and
`<Grammar>LanguageMetaData`. The two tiers coincide only while a project has a
single grammar, which is why `--grammar` exists at all.

Nothing else is named, because nothing else has to be: the language ids
`order-flow-domain` / `-process` / `-layout`, the file extensions `.domain` /
`.process` / `.layout`, the grammar filenames and each grammar's entry rule
(`DomainModel`, `ProcessModel`, `LayoutModel` — per-grammar, because one
`langium-cli` run emits one combined `ast.ts`) all follow from the project and
grammar names.

`--monorepo` is the one flag that is about the *repo* rather than the language.
It makes `tsconfig.json` extend the root config that actually carries
`compilerOptions` — `tsconfig.json` at this repo's root is a solution file, so
extending that would inherit nothing — swaps the standalone `.gitignore` for the
workspace-member one, which keeps only the rule a monorepo root cannot be assumed
to have (`syntaxes/`, a Langium artefact) — and
addresses this package by `--prefix` in the regen command it writes into
`package.json`. It never writes outside the target: the `workspaces` entry a new
package needs is printed for you to add.

That is what "the templates are derived from the reference example" is supposed
to mean: running the command reproduces the example's own shape rather than
something the example then has to edit. `langium-config.json` here is
byte-for-byte the scaffold's output, which is only possible because `init`
emits every grammar of a multi-grammar project into one config.

Two gates keep this section honest rather than aspirational:

- `packages/cli/test/fixtures/init-scaffold*.txt` are goldens of the rendered
  scaffold — the single-grammar default, this example's own three-grammar
  invocation, and the three-head shape — so a template change shows up as a diff
  of the emitted project.
- `scripts/check-init-provenance.mjs` re-runs the invocation above and checks
  every emitted file against a manifest the Layout table below restates — that
  `langium-config.json` and `src/services.ts` are byte-for-byte the scaffold's,
  that each *adapted* file really does differ, and that nothing `init` emits is
  missing from the manifest. A verdict cannot silently drift from the scaffold
  it describes.

Everything after step 1 is hand-written, and the table below says which is
which. Not knowing what you are expected to write yourself is the most
confusing thing about a scaffolded example.

| Step | Command / edit | Result |
| --- | --- | --- |
| 1 | `hydranium-cli init` | the whole skeleton: one starter grammar per `--grammar` plus the shared terminal fragment, a single `langium-config.json` carrying one entry per grammar, LSP + data heads, a test setup |
| 2 | write `src/grammar/domain.langium` | replaces the starter grammar the scaffold emits at that same path |
| 3 | `hydranium-cli lint-grammar --services ./lib/services.js` | grammar-convention smells |
| 4 | `hydranium-cli reflect --services ./lib/services.js` | the AST shape just created |
| 5 | write `src/grammar/process.langium` and `layout.langium` | replaces two more starter grammars — the `langium-config` entries and the `additionalLanguages` wiring are already there |
| 6 | `hydranium-cli generate-transfer-model` | transfer types for the data head |
| 7 | bind the adopter services in `order-flow-module.ts` | *hand-written* |
| 8 | `hydranium-cli validate --services ./lib/services.js ../workspace` | exits non-zero on the broken fixture |

Neither the grammar count nor the head set is hand-work. `--grammar` is
repeatable, so the multi-grammar composition (`additionalLanguages`, the shared
terminal fragment, the explicit `lsp.configurationRoot`) is generated; and
`--heads lsp,data,glsp` derives the dependency list, the `main.ts` composition
and a diagram's DI wiring from the head set.

**This example's GLSP head is hand-written, and the invocation above
deliberately leaves `glsp` out.** What `init` scaffolds is the FULL-TEXT
strategy — `FullTextHydraniumGlspState`, whose source model is the whole
document text round-tripped by re-parsing — because that is the natural starting
point and the shape a single-grammar project suits. This example runs the
reconciling multi-document strategy instead, so that its `.process` edits and
`.layout` layout reconcile per field across two files. Those are different
classes, not a customisation of the scaffolded ones, which is why the provenance
manifest records `src/main.ts` as *adapted* rather than pretending the head came
from the scaffold.

## Layout

| Path | Origin |
| --- | --- |
| `langium-config.json` | **identical** to the scaffold — all three language entries, ids, extensions and TextMate paths are what the invocation above emits |
| `package.json` | **adapted** — the example's own `example-` name and metadata, its `order-flow-server` rename of the first `bin` key (the second, `order-flow-data-server`, is the scaffold's), the bench / lint / measure-memory scripts, and the GLSP head's dependencies. `"private": true` is not in that list — it is what the scaffold emits unless `--public` asks otherwise. `--monorepo` derives only the `--prefix` in the regen command |
| `tsconfig.json` | **identical** to the scaffold — `--monorepo` finds the root config that carries `compilerOptions` (the repo root's `tsconfig.json` is a solution file) and prunes the options the base already supplies |
| `tsconfig.test.json` | **identical** to the scaffold — which emits `isolatedModules` too, so the typecheck agrees with the esbuild transform vitest actually runs the tests through |
| `vitest.config.ts` | **adapted** — uses the repo's shared vitest config |
| `src/index.ts` | **adapted** — widened to the example's own surface |
| `src/services.ts` | **identical** to the scaffold — the contract is language-count-agnostic |
| `src/main.ts` | **adapted** — adds the GLSP head on the reconciling strategy, and the data head's root type is the union of every grammar's transfer root |
| `src/data-server-main.ts` | **adapted** — `init` emits this entry with the `data` head; what differs here is the transfer-import comment naming `.layout` as the third grammar one data server serves |
| `src/head-ports.ts` | **adapted** — adds the GLSP command, which the default head set does not emit |
| `.gitignore` | **dropped** — the scaffold does emit the member ignore file; this example predates that template, so the repo root ignores its `syntaxes/` by wildcard instead. Adding the file would be correct, and the root pattern would have to stay either way |
| `test/services.test.ts` | **replaced by** `test/composition.test.ts`: rendered at this three-grammar invocation the scaffolded test already asserts all three, being grammar-agnostic — the successor widens it to what composing them into ONE shared tier means: shared-tier identity, per-extension routing, per-language serializers, the scope-provider overrides and the explicit `lsp.configurationRoot` |
| `test/serialization.test.ts` | **replaced by** `test/serializer.test.ts`: the scaffolded round-trip covers one grammar over the starter syntax, this example covers three real ones with a workspace-wide golden beside it |
| `test/parsing.test.ts` | **dropped** — the scaffold emits it; here the real grammars are parsed by every suite that loads the workspace fixture |
| `test/linking.test.ts` | **replaced by** `test/project-visibility.test.ts`: widened from "a reference resolves" to which tier exports it and who can see it across projects |
| `test/validating.test.ts` | **replaced by** `test/process-transition-rules.test.ts`: this example binds real checks, so it asserts those rather than the framework's linker diagnostics |
| `src/grammar/domain.langium` | **adapted** — the real grammar, over the starter one the scaffold emits at this path |
| `src/grammar/process.langium` | **adapted** — likewise, over the second starter grammar |
| `src/grammar/layout.langium` | **adapted** — likewise, over the third |
| `src/grammar/common.langium` | **adapted** — and the thinnest in this table: the token set is exactly the scaffold's four (`NUMBER` is declared in `layout.langium`), so what differs is a fragment-specific comment and the `ML_COMMENT` / `SL_COMMENT` order. A comment tidy here flips the verdict |
| `src/language-server/order-flow-module.ts` | **adapted** — composes all three languages |
| `src/language-server/ast.ts` | **adapted** — adds the cross-grammar computed-property augmentations |
| `src/language-server/order-flow-project-manager.ts` | hand-written — folder-scoped projects |
| `src/language-server/order-flow-scope-computation.ts` | hand-written — `public` → the public visibility tier |
| `src/language-server/process-scope-provider.ts` | hand-written — the dependent-reference chain in `.process` |
| `src/language-server/layout-scope-provider.ts` | hand-written — narrows `DiagramNode.flowNode` to the process the `.layout` file declares |
| `src/language-server/domain-serializer.ts` | **adapted** — the real grammar's syntax, over the starter emitter the scaffold now writes at this path |
| `src/language-server/process-serializer.ts` | **adapted** — likewise, for the second grammar |
| `src/language-server/layout-serializer.ts` | **adapted** — likewise, for the third |
| `src/language-server/order-flow-integrity.ts` | hand-written — name-uniqueness repair on `.domain` and `.process` |
| `src/language-server/process-validation.ts` | hand-written — the text-side transition checks |
| `src/language-server/process-transition-rules.ts` | hand-written — the transition well-formedness rules, as free functions the validator, the edge-creation checker and the create-transition handler all call, so text and diagram cannot disagree |
| `src/language-server/order-flow-stdlib.ts` | hand-written — the primitive types, seeded as an indexed virtual document with no `project` header so they resolve from anywhere |
| `src/language-server/order-flow-ast-extension.ts` | hand-written — the cross-grammar computed property |
| `src/language-server/order-flow-ast-builder.ts` | hand-written — a node factory pre-bound to this project's reflection, so the GLSP handlers build AST nodes without casting past the generated types |
| `src/language-server/generated/**` | `langium generate` output, committed |
| `src/language-server/generated-transfer/**` | `hydranium-cli generate-transfer-model` output, committed |
| `src/glsp/**` | hand-written — the `.process` diagram on the reconciling multi-document strategy, with `.process` as the primary document and `.layout` as the secondary |
| `src/measure-memory.ts` | hand-written — the entry point the `measure-memory` script runs |
| `src/testing/large-workspace.ts` | hand-written — the large perf fixture's generator |
| `scripts/generate-large-workspace.mjs` | hand-written — the CLI front for that generator |
| `syntaxes/**` | `langium generate` TextMate output, gitignored |
| `test/*.test.ts`, `test/order-flow-harness.ts` | hand-written |

## Adopter services, and what each one is for

| Slot | Bound on | Why the framework default is not enough |
| --- | --- | --- |
| `workspace.ProjectManager` | shared | A project is a folder here, declared by whichever `.domain` file carries a `project` header |
| `lsp.configurationRoot` | shared | Its default is the FIRST registered language id, which with more than one grammar is registration order rather than a decision |
| `additionalDocuments` | shared | Seeds the primitive types as an indexed virtual document. It carries no `project` header, so `String` / `Number` / `Boolean` export at the `universal` tier and resolve without a `requires` |
| `references.ScopeComputation` | `.domain`, `.process`, `.layout` | Maps the grammar's `public` modifier onto the framework's `public` visibility tier; the default keys that decision off name shape, which this language does not vary. Bound on every language so one rule governs the whole workspace, even though only `.domain` declarations carry the modifier |
| `references.ScopeProvider` | `.process`, `.layout` | Dependent references, where a reference's candidates depend on a previous one having resolved: the `writes Order.status = PAID` chain in `.process`, and `DiagramNode.flowNode` narrowed to the declared process in `.layout`. `.domain` has none, and keeps the framework default |
| `integrity.rules` | `.domain`, `.process` | Name-uniqueness repair at `IntegrityPhase.Parsed`, dispatched by `nodeType` so each rule sees only its own grammar. Not bound on `.layout`: a `DiagramNode` has no name, so there is nothing to keep unique |
| `validation.checks` | `.process` | The text half of the transition rules the diagram also enforces, so a hand-edited file reports what the canvas refuses |
| `ast.extensions` | `.domain`, `.process` | `Task._writtenFields` holds `.domain` `Field` nodes reached through the `.process` effect chain — a property no single grammar can express. `.layout` derives nothing |
| `serializer.Serializer` | per language | A serializer is always grammar-shaped, so the framework can default none of them |

## Build and test

This is a workspace package of the framework repo, so `@hydranium/*` resolves
to the local `packages/*` checkout rather than to the registry, where the
packages are not yet published:

```bash
npm --prefix examples/order-flow/server run build   # langium generate + tsc
npm --prefix examples/order-flow/server test
```

The suite covers the language tier (composition, folder-scoped projects and
visibility, the effect chain, each grammar's serializer, integrity and the
AST extensions), each head end to end over its real transport — the `test/glsp`
diagram suites, the data-server and LSP integration tests, and the
`test/smoke` socket and stdio entry points — and the framework's conformance
kit, one suite per head.

The `test/smoke` suites spawn the built `lib/main.js` as a real child process.
The spawn, the `initialize` handshake, the diagnostics / `window/logMessage` /
stderr captures, the polled port lookup and the `SIGKILL`-backed teardown are
framework surface (`startSpawnedServer` from `@hydranium/core/testing/node`), so
`test/smoke/spawned-order-flow-server.ts` supplies only what is specific to this
example: which built entry to run and what to call its workspace folder. Copy
that file's shape rather than its contents.

One thing to know if you bind integrity in your own language: the service's
default `'silent'` sync mode **writes its repairs back to disk**, through the
serializer, so closed files get rewritten and lose their comments. Bind the
service with an explicit `syncMode` if that is not what you want. The tests
here build temp-directory copies of their fixtures for the same reason.

## The large workspace fixture

`examples/order-flow/workspace` is seven files — enough to read, far too small
to measure. Profiling, `watch` and any incremental-rebuild claim need volume, so
a **deterministic generator** produces one on demand:

```bash
npm --prefix examples/order-flow/server run generate:large-workspace
# → examples/order-flow/workspace-large, which is gitignored
# The generator prints its own per-extension counts and the seed it used;
# the sizes it defaults to are LARGE_WORKSPACE_DEFAULTS in
# src/testing/large-workspace.ts, which is the only place they are stated.

npm --prefix examples/order-flow/server run generate:large-workspace -- \
   --projects 4 --entities 6 --processes 3 --seed 1 --out /tmp/small
```

The generator is committed and its output is not: a fixed seed reproduces the
corpus byte for byte, so the repo carries a reproducible artefact instead of a
few hundred generated files. The size flags exist because the signal a perf run
carries is the **curve across two sizes** — an O(n²) regression in discovery,
indexing, scope or linking shows as the large/small ratio outrunning the
file-count ratio, which a single size can never reveal.
`src/testing/large-workspace.ts` is a module rather than only a script so a
bench can call it in-process.

Every generated file is valid against all three grammars, with the cross-project
`requires` edges and the cross-grammar `subject` / effect / layout references —
a corpus of `.domain` files alone would measure a third of this example. The
acceptance contract is zero errors:

```bash
node packages/cli/lib/cli.js validate \
   --services examples/order-flow/server/lib/services.js \
   examples/order-flow/workspace-large
# No problems found in <n> files.   (one more than the generator wrote: the
#                                    stdlib virtual document counts as one)
```

There is deliberately no `check:` script over the fixture — a stale corpus on
someone's disk cannot break a build. What can rot is the generator's agreement
with the grammars, so `test/large-workspace-fixture.test.ts` runs it small and
builds the result on every `npm test`.

One more packaging constraint, if you copy this `package.json`: the framework
treats `langium` and its `vscode-*` chain as one atomic set and depends on a
single physical copy: `@hydranium/langium` re-exports `langium`, and that
re-export is only identity-transparent — the same `URI` class object, the same
nominal `AstNode` — while one install exists. Two installs break `instanceof`
across the seam. This example declares ordinary ranges and the repo root
collapses them with an npm `overrides` block; outside this repo you have to
supply that pin yourself, since a floating range can otherwise resolve a second
copy under a transitive dependency.
