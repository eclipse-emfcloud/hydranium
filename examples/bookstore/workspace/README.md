# bookstore sample workspace

The models `examples/bookstore/server` is exercised against. One grammar, no
project descriptor, two files.

```
catalogue.bookstore   the shop and its two shelves
orders.bookstore      one restock order, referencing a shelf in the other file
```

What it exists to show, all of it out of the box:

- **A cross-document reference with nothing configured.** The grammar declares
  no `project` header, so every name is exported at the `universal` tier and
  `WeeklyRestock -> Fiction` resolves across files without a scope
  contribution, a project descriptor or a `requires` edge.
- **Hover with no hover provider.** Each node carries a `/** … */` comment, and
  Langium's default hover renders it. The scaffold binds no `HoverProvider` —
  this is the framework default answering.
  **The second asterisk is load-bearing**, and a plain `/* … */` is the trap:
  `MultilineCommentHoverProvider` goes through `JSDocDocumentationProvider`,
  whose `isJSDoc` check defaults to a `/**` opener, so an ordinary block comment
  is lexed as `ML_COMMENT`, found by the comment provider, and then silently
  yields no documentation at all. Measured both ways against this fixture.
- **The text a diagram edit produces.** Creating a node on the `.bookstore`
  canvas appends a `node <name>` line here, through the GLSP head's starter
  create handler.

Run the CLI against it:

```bash
hydranium-cli validate \
   --services examples/bookstore/server/lib/services.js \
   examples/bookstore/workspace
```

That exits zero: unlike `order-flow`'s fixture, nothing here is deliberately
broken. Bookstore's job is the shape a new adopter gets on day one, so a
seeded failure would be one more thing it does not scaffold.
