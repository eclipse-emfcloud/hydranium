# @hydranium/bookstore-protocol

What the Bookstore language server and its clients both import, so a client
never depends on the server or installs Langium.

- `src/generated-hydranium/languages.ts` — each language id and its file extensions
- `src/generated-hydranium/transfer-model.ts` — the wire types of the model, references as plain strings
- `src/head-ports.ts` — the LSP requests a host sends to find the socket heads
- `src/bookstore-diagram-types.ts` — the `Bookstore` diagram's type ids

The server's `npm run generate` writes `src/generated-hydranium/` from the
grammar, and `npm run build` here runs it first. Commit the generated
modules with the grammar change that produced them.
