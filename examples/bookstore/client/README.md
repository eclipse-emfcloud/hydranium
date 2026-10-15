# @hydranium/bookstore-client

The host-neutral client side of the Bookstore language: what every host of it
mounts, whatever that host is. It reads the element ids from the protocol
package and never depends on the server.

- `src/bookstore-diagram-module.ts` — the `Bookstore` diagram: a registration per element type, its container module, and `initializeBookstoreDiagramContainer`
- `src/index.ts` — the package root, re-exporting each module

A host builds a diagram container with the initializer, passing its own
modules: they go first and the diagram definition last, since GLSP gives an
element type to whichever module registered it last.
