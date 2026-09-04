# Hydranium documentation

The navigation layer for `docs/`. Grouped by **who a page is for**, because the
three audiences want different things from the same framework and the fastest
way to waste someone's afternoon is to hand a release runbook to an adopter.

- **[Adopting](#adopting--i-am-building-a-language-on-hydranium)** — you are
  building a modeling language on Hydranium.
- **[Concepts](#concepts--why-it-is-shaped-this-way)** — the constraints behind
  the design. Mostly for adopters, useful to everyone.
- **[Contributing](#contributing--i-am-working-on-hydranium-itself)** — you are
  working on Hydranium itself.

## Adopting — I am building a language on Hydranium

- [**Status, limitations and roadmap**](adopting/status.md) — alpha, pre-v0,
  what is known-missing, and the versioning policy. Read this first.
- [**Requirements**](adopting/requirements.md) — what your own project has to
  satisfy: the Node floor, the single-copy Langium chain, and the
  `moduleResolution` setting `vscode-jsonrpc@9` forces on you.
- [**Troubleshooting a server you are building**](adopting/troubleshooting.md) —
  failure modes whose message names the wrong layer: duplicate `langium` /
  `vscode-jsonrpc` copies, an unbound `workspace/applyEdit`, missing semantic
  tokens under a Theia plugin-host.
- The [repository README](../README.md) carries the getting-started path: one
  `hydranium-cli init` invocation to a buildable project.

Task-shaped guides — "add a data-server method", "make a diagram editable",
"add a cross-document validation" — do not exist yet. They are roadmap item 7
in [Status](adopting/status.md#roadmap). Until then the concept pages below,
and the two examples, are what carries that job.

## Concepts — why it is shaped this way

Read these when a framework decision looks arbitrary and you want the
constraint behind it.

- [**Architecture**](concepts/architecture.md) — the three heads, the layered
  shared workspace, and how they connect. The one-page mental model, with a
  diagram.
- [**Framework vs. adopter**](concepts/framework-vs-adopter.md) — the scope,
  naming, visibility and completion seams, each shown as a framework default
  beside a real override. The best single entry point for an adopter.
- [**Element addressing**](concepts/element-addressing.md) — the four terms for
  addressing an element (name, reference name, key, id) and the two axes whose
  members are spelled alike.
- [**Scope and visibility**](concepts/scope-and-visibility.md) — the three
  orthogonal axes, the per-tier filter rules, and the two services that turn
  them into answers at a query site.
- [**Adopter contributions**](concepts/contributions.md) — synthetic AST
  (nodes and documents no file produced) and the registration pattern all four
  registry services share.
- [**Document layers**](concepts/document-layers.md) — the four things
  "document" means, why the last two are deliberately not one type, and why
  there is no transfer→AST converter.
- [**Shared vs. language DI scope**](concepts/shared-vs-language-di-scope.md) —
  which services live once per process and which once per grammar.
- [**Build-pipeline registries**](concepts/build-pipeline-registries.md) — how
  work is ordered at a Langium document phase, and the priority bands.
- [**Browser hosting**](concepts/browser-hosting.md) — running a head in a web
  worker: the bundler accommodations, the filesystem seam, and what a browser
  host supports.
- [**Head module maps**](concepts/head-module-maps.md) — the key modules of
  `core`/LSP, `data-server` and `glsp-server`, and how they wire. The
  module-level companion to Architecture.

## Contributing — I am working on Hydranium itself

- [**Contributing**](../CONTRIBUTING.md) — setup, the gate, and commit
  conventions. Start here.
- [**Conventions**](contributing/conventions.md) — class-role naming, member
  visibility, service shape, comment rules, test-support builders. The longest
  document here and the one to search rather than read.
- [**Testing**](contributing/testing.md) — the test layers, which one a change
  needs, the commands, and the traps that have cost time before.
- [**Troubleshooting the repository**](contributing/troubleshooting.md) —
  failures that only happen while building or testing this repo: the cold-clone
  `hydranium-cli: not found`, the vitest dep-optimizer cache, a segfaulting
  native addon, a Playwright server that outlived its run.
- [**Releasing**](contributing/releasing.md) — the changesets flow.
- [**Performance baseline**](contributing/perf-baseline.md) — how to reproduce
  the build-cost and resident-heap measurements, so a number you take is
  comparable with one taken before your change.

## Elsewhere in the repository

- **Package READMEs** — one per published package under
  [`packages/`](../packages/), each covering its exports, its peers and which
  entries are browser-neutral.
- **Example READMEs** — [`examples/order-flow/`](../examples/order-flow/README.md)
  is the multi-grammar example the framework gates on;
  [`examples/bookstore/`](../examples/bookstore/README.md) is the single-grammar
  on-ramp that matches what `init` scaffolds.
