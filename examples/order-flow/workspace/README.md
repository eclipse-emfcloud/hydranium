# order-flow sample workspace

The models every order-flow host opens and the test suites copy. Two
projects, three grammars, one deliberately broken file.

> This directory is a test fixture that two launches edit in place. See
> [The fixture workspace is edited in place](../README.md#the-fixture-workspace-is-edited-in-place)
> before you open it.

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

A project is a folder, declared by whichever `.domain` file in it carries a
`project` header. `requires` becomes `Project.dependencies`, which the
framework's project-scope filter walks to decide what crosses the boundary.

What you can observe here:

- **Cross-project resolution.** `Order.total: Money` reaches `commerce-core`
  because `Money` is `public` and `orders` requires that project.
- **A visibility tier failing.** `audit-leak.domain` references `AuditStamp`,
  which is not `public`. It must stay unresolved, and completion in `orders`
  must not offer it.
- **Cross-grammar resolution.** `fulfillment.process` reaches `Order`,
  `Order.status` and `OrderStatus.PAID`, a chain where each reference's
  candidate set depends on the previous one having resolved.
- **Layout as a separate, optional document.** `fulfillment.layout` positions
  the nodes of `fulfillment.process`. `OrderFlowLayoutScopeProvider` scopes
  its entries to the same-named `.process` file, so an entry cannot bind to a
  same-named node of another process. `returns.process` has no layout, which
  shows layout is additive. Dragging a node rewrites an entry; creating one
  from the canvas writes both files in one operation, the process first.
- **Chosen coordinates.** Nodes run left to right by rank, and the gateway's
  two branches split vertically, so each leaves a different face of the
  diamond. `Cancel` has no entry and lands at the origin, so the other entries
  start clear of it.

Run the CLI against it:

```bash
hydranium-cli validate \
   --services examples/order-flow/server/lib/services.js \
   examples/order-flow/workspace
```

That exits non-zero, by design: `audit-leak.domain` is the fixture proving
the gate can fail.
