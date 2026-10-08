# bookstore sample workspace

The models `examples/bookstore/server` is exercised against. One grammar, no
project descriptor, two files.

```
catalogue.bookstore   the shop and its two shelves
orders.bookstore      one restock order, referencing a shelf in the other file
```

What it shows, all of it out of the box:

- **A cross-document reference with nothing configured.** The grammar declares
  no `project` header, so every name is exported at the `universal` tier and
  `WeeklyRestock -> Fiction` resolves across files without a scope
  contribution, a project descriptor or a `requires` edge.
- **Hover with no hover provider.** Each node carries a `/** … */` comment,
  and Langium's default hover renders it. Keep the second asterisk: the hover
  reads comments through `JSDocDocumentationProvider`, which accepts only a
  `/**` opener, so a plain `/* … */` comment silently yields no hover.
- **The text a diagram edit produces.** Creating a node on the `.bookstore`
  canvas appends a `node <name>` line here, through the GLSP head's starter
  create handler.

```bash
hydranium-cli validate \
   --services examples/bookstore/server/lib/services.js \
   examples/bookstore/workspace
```

That exits zero: nothing here is deliberately broken.
