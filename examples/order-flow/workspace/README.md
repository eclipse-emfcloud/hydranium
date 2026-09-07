# order-flow sample workspace

The models `examples/order-flow/server` is exercised against. Two projects,
three grammars, one deliberately broken file.

> **This directory is a TEST FIXTURE, and the F5 launch edits it in place.**
> `Run Order Flow VS Code Extension — order-flow-workspace` opens this folder,
> so anything you type in the Extension Development Host — or write from the
> properties panel, which reserializes the whole document — changes the seed
> every suite copies with `makeScratchWorkspace`. Nothing warns you: the tests
> still pass their own scratch copy, they just copy the file you changed. A
> panel write to `returns.process` once turned into two failing GLSP
> conformance tests that looked like a regression in GLSP.
>
> **`git status examples/order-flow/workspace` after any launch**, and
> `git checkout --` what you did not mean to keep. Deliberate fixture changes
> are fine; unnoticed ones are what cost time.

```
commerce-core/          shared library project
   money.domain         project descriptor; public Money, ID, Address
   internal.domain      AuditStamp — project-visible only
orders/                 consuming project (requires commerce-core)
   orders.domain        project descriptor; Order, OrderStatus, LineItem
   fulfillment.process  the writes/reads effect chain into orders.domain
   fulfillment.layout   node positions for fulfillment.process, in their own file
   returns.process      a second process over the same entity, with no layout
   audit-leak.domain    DELIBERATELY BROKEN — references AuditStamp
```

A project is a **folder**, declared by whichever `.domain` file in it carries
a `project` header. `requires` becomes `Project.dependencies`, which the
framework's project-scope filter walks to decide what crosses the boundary.

These are observable here rather than merely asserted:

- **Cross-project resolution.** `Order.total: Money` reaches `commerce-core`
  because `Money` is `public` and `orders` requires that project.
- **A visibility tier failing.** `audit-leak.domain` references `AuditStamp`,
  which is not `public`. It must stay unresolved, and completion in `orders`
  must not offer it.
- **Cross-grammar resolution.** `fulfillment.process` reaches `Order`,
  `Order.status` and `OrderStatus.PAID` — a chain where each reference's
  candidate set depends on the previous one having resolved.
- **Layout as a separate, optional document.** `fulfillment.layout` positions
  `fulfillment.process`'s nodes from its own file, scoped to that process
  rather than to every flow node in the workspace; `returns.process` has none,
  which is what shows layout is additive rather than required.

Run the CLI against it:

```bash
hydranium-cli validate \
   --services examples/order-flow/server/lib/services.js \
   examples/order-flow/workspace
```

That exits non-zero, by design: `audit-leak.domain` is the fixture proving
the gate can fail.
