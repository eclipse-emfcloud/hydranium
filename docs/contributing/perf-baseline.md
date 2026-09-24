# Performance baseline

How to reproduce the framework's build-cost and resident-heap measurements, so a
number you take is comparable with one taken before your change rather than
re-derived from a different procedure.

## Reproducing

No adopter and no generated corpus needed up front: the bench writes its own
fixtures into temp dirs from the committed generator, at a fixed seed.

```bash
npm run bench                    # → examples/order-flow/server, vitest bench
```

For the memory dimension over the full-size corpus, generate it first:

```bash
npm --prefix examples/order-flow/server run generate:large-workspace
npm --prefix examples/order-flow/server run measure-memory -- \
   ../workspace-large --edits=20
```

`measure-memory` churns `.domain` files deliberately — `.process` and `.layout`
both reference `.domain`, so that is the edit whose rebuild fans out across all
three languages.

The corpus is produced by a **deterministic generator**
(`examples/order-flow/server/src/testing/large-workspace.ts`, exercised at a
small size by `test/large-workspace-fixture.test.ts`), and the directory it
writes is gitignored: any contributor reproduces it byte for byte from the fixed
seed, and the repository does not carry ~435 generated model files. The
acceptance contract is `hydranium-cli validate` reporting **zero errors** over
the generated root, which it does at 436 documents (435 files plus the stdlib
virtual document).

The recorded series itself — dated blocks, one per framework state — is kept in
the maintainers work log rather than here. Reproduced on your own hardware the
procedure above is meaningful; the absolute numbers are not transferable, which
is why they are recorded where their context is. A published figure would
describe one machine while reading as the framework's, and nothing regenerates
it as the code moves.

What a block records, so a later one is comparable with it: machine, Node
version, source revision, corpus seed and shape, command, run count and warmup,
and the raw observations — the Vitest distribution rows and the bounded probe
samples, not means alone. Take at least three `npm run bench` runs and three
`measure-memory` runs, because a single run of each shows no spread to judge
the next against.

Timing budgets are tracking budgets, not portable CI gates: a figure from one
machine gates nothing on another. They are kept beside the observations they
were derived from, and each names its workload, the quantity measured, and what
investigation follows a miss.
