# order-flow — the framework's multi-grammar example server

Order fulfillment, split into three grammars with deliberately asymmetric head
affinity:

- **`*.domain`** — entities, value types, enumerations, typed fields.
  Structural and refactor-heavy, so text is the better editor.
- **`*.process`** — tasks, gateways, transitions over a domain entity.
  A flow is better edited as a graph, where topology errors that are invisible
  in text are obvious.
- **`*.layout`** — node bounds for a process. Purely additive: a `.process`
  with no `.layout` file is still complete.

References point one way down the chain: `.layout` depends on `.process`
depends on `.domain`, never the reverse. The seam the example exists for is a
single line of `.process`:

```
task Pay writes Order.status = PAID
```

Three cross-references, each scoped by the previous one: an entity, a field of
that entity, then a literal of the enumeration that field is typed with. Rename
`OrderStatus.PAID` in `.domain` and the `.process` file follows; retype the
field and the assignment stops linking.

Models live in [`../workspace`](../workspace), which also carries the
two-project visibility demonstration and its negative fixture.

## Adoption guides derived from this example

The example is the working source for the task guides:

- [validation check](../../../docs/guides/add-validation-check.md) follows the
  process validation checks;
- [data-server method](../../../docs/guides/data-server-method.md) follows the
  data head's typed protocol extension;
- [editable diagram](../../../docs/guides/editable-diagram.md) follows the
  process diagram module and operation handlers.

The guides generalise the seams; this example remains the executable reference
for the complete three-grammar composition.

All three grammars come from one `langium-cli` run, so one generated reflection
knows every type. Why that matters, and what to bind when your grammars are
generated separately, is in
[Service placement and composition](../../../docs/contributing/design/service-placement.md#one-reflection-over-every-grammar);
`test/composition.test.ts` pins the one-run shape.

## Where to look

| Concern | Files |
| --- | --- |
| Grammars | [`src/grammar/`](src/grammar) |
| Service composition | [`order-flow-module.ts`](src/language-server/order-flow-module.ts), [`services.ts`](src/services.ts) |
| Folder-scoped projects and visibility | [`order-flow-project-manager.ts`](src/language-server/order-flow-project-manager.ts), [`order-flow-scope-computation.ts`](src/language-server/order-flow-scope-computation.ts) |
| Dependent references | [`process-scope-provider.ts`](src/language-server/process-scope-provider.ts), [`layout-scope-provider.ts`](src/language-server/layout-scope-provider.ts), [`layout-file.ts`](src/language-server/layout-file.ts) |
| Primitive types | [`order-flow-stdlib.ts`](src/language-server/order-flow-stdlib.ts) |
| Validation | [`process-validation.ts`](src/language-server/process-validation.ts), [`process-transition-rules.ts`](src/language-server/process-transition-rules.ts), [`layout-validation.ts`](src/language-server/layout-validation.ts) |
| Integrity repair | [`order-flow-integrity.ts`](src/language-server/order-flow-integrity.ts) |
| Cross-grammar computed property | [`order-flow-ast-extension.ts`](src/language-server/order-flow-ast-extension.ts), [`ast.ts`](src/language-server/ast.ts) |
| Serializing, formatting, comments | [`domain-serializer.ts`](src/language-server/domain-serializer.ts), [`process-serializer.ts`](src/language-server/process-serializer.ts), [`layout-serializer.ts`](src/language-server/layout-serializer.ts), [`order-flow-formatter.ts`](src/language-server/order-flow-formatter.ts), [`order-flow-trivia.ts`](src/language-server/order-flow-trivia.ts) |
| Hover and highlighting | [`order-flow-hover.ts`](src/language-server/order-flow-hover.ts), [`order-flow-semantic-tokens.ts`](src/language-server/order-flow-semantic-tokens.ts) |
| Translations | [`src/messages/`](src/messages), [`src/nls/`](src/nls), [`order-flow-message-renderer.ts`](src/language-server/order-flow-message-renderer.ts) |
| Diagram (`.process` with `.layout` as secondary) | [`src/glsp/`](src/glsp), operation handlers in [`src/glsp/handler/`](src/glsp/handler) |
| Head entry points | [`main.ts`](src/main.ts), [`data-server-main.ts`](src/data-server-main.ts), [`head-ports.ts`](src/head-ports.ts) |
| Perf fixture and memory measurement | [`src/testing/large-workspace.ts`](src/testing/large-workspace.ts), [`measure-memory.ts`](src/measure-memory.ts) |

## How this directory was built

It starts from one `init` invocation:

```bash
hydranium-cli init examples/order-flow/server --name OrderFlow \
  --grammar Domain --grammar Process --grammar Layout --monorepo
```

`--name` names the project and its shared tier; each `--grammar` adds one
language, and its id, extension, grammar file and entry rule follow from the
names. `--monorepo` makes `tsconfig.json` extend the root config that carries
`compilerOptions` and addresses the package by `--prefix` in the regen
command. The GLSP head is left out on purpose: `init` scaffolds the full-text
diagram strategy, and this example runs the reconciling multi-document one, a
different set of classes.

What happened to each file `init` emits:

| Verdict | Files |
| --- | --- |
| identical | `langium-config.json`, `tsconfig.json`, `tsconfig.test.json`, `src/services.ts` |
| adapted | `package.json`, `vitest.config.ts`, `README.md`, `src/index.ts`, `src/main.ts` (adds the GLSP head), `src/data-server-main.ts`, `src/head-ports.ts`, the four `src/grammar/*.langium`, `order-flow-module.ts`, `ast.ts` and the three serializers |
| replaced | the scaffolded `services`, `serialization`, `linking` and `validating` tests, by `composition`, `serializer`, `project-visibility` and `process-transition-rules` |
| dropped | `.gitignore` (the repo root's rules cover `lib/` and `syntaxes/`), `test/parsing.test.ts` |
| hand-written | everything else in `src/`, `scripts/` and `test/`, including the whole GLSP head |
| generated, committed | `src/language-server/generated/**`, `src/language-server/generated-hydranium/**` |

`scripts/check-init-provenance.mts` re-runs the invocation and holds every
emitted file to its verdict; its manifest carries the reason for each one. The
gate does not read this table, so a verdict change needs a hand edit here.

## Adopter services, and what each one is for

| Slot | Bound on | Why the framework default is not enough |
| --- | --- | --- |
| `workspace.ProjectManager` | shared | A project is a folder here, declared by whichever `.domain` file carries a `project` header |
| `lsp.configurationRoot` | shared | Its default is the FIRST registered language id, which with more than one grammar is registration order rather than a decision |
| `additionalDocuments` | shared | Seeds the primitive types as an indexed virtual document. It carries no `project` header, so `String` / `Number` / `Boolean` export at the `universal` tier and resolve without a `requires` |
| `references.ScopeComputation` | `.domain`, `.process`, `.layout` | Maps the grammar's `public` modifier onto the framework's `public` visibility tier; the default keys that decision off name shape, which this language does not vary. Bound on every language so one rule governs the whole workspace, even though only `.domain` declarations carry the modifier |
| `references.ScopeProvider` | `.process`, `.layout` | Narrowed references: the `writes Order.status = PAID` chain in `.process`, where each reference's candidates depend on the previous one having resolved, and `DiagramNode.flowNode` narrowed to the same-named process in `.layout`. `.domain` has none, and keeps the framework default |
| `integrity.rules` | `.domain`, `.process` | Name-uniqueness repair at `IntegrityPhase.Parsed`, dispatched by `nodeType` so each rule sees only its own grammar. Not bound on `.layout`: a `DiagramNode` has no name, so there is nothing to keep unique |
| `validation.checks` | `.process` | The text half of the transition rules the diagram also enforces, so a hand-edited file reports what the canvas refuses |
| `ast.extensions` | `.domain`, `.process` | `Task._writtenFields` holds `.domain` `Field` nodes reached through the `.process` effect chain — a property no single grammar can express. `.layout` derives nothing |
| `serializer.Serializer` | per language | A serializer is always grammar-shaped, so the framework can default none of them |

## Build and test

`@hydranium/*` resolves to the local `packages/*` checkout, since this is a
workspace package of the framework repo:

```bash
npm --prefix examples/order-flow/server run build   # generate + tsc
npm --prefix examples/order-flow/server test
```

The suite covers the language tier, each head end to end over its real
transport, and the framework's conformance kit, one suite per head, with the
GLSP one run again over the built entry's socket. The `test/smoke` suites
spawn the built `lib/main.js` as a child process through `startSpawnedServer`,
described in [Test your language](../../../docs/guides/test-your-language.md);
`test/smoke/spawned-order-flow-server.ts` supplies only the entry to run and
the workspace folder name. Copy that file's shape rather than its contents.

If you bind integrity in your own language: the service's default `'silent'`
sync mode writes its repairs to closed files on disk, through the serializer.
Comments and the file's ending survive through the `trivia` preservers; the
hand-formatting around them does not. Pass an explicit `syncMode` if that is
not what you want. The tests here work on temp-directory copies of their
fixtures for the same reason.

The generator for a large perf workspace and how to measure with it are in
[Performance baseline](../../../docs/contributing/perf-baseline.md). If you copy
this `package.json`, pin `langium` and its LSP stack as
[Requirements for a consuming project](../../../docs/adopting/requirements.md)
describes. Inside this repo the root `overrides` block pins `langium`, and this
`package.json` pins the LSP stack itself.
