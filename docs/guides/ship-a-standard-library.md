# Ship a standard library

Use this when your language has built-ins that every model can reference
without importing anything: primitive types, a base library of common
definitions. The order-flow example ships `String`, `Number` and `Boolean` this
way, in `server/src/language-server/order-flow-stdlib.ts`.

Heads: any

## The seam

A standard library is a document no file backs. You hand it to the workspace
through an `AdditionalDocumentContribution` in the shared `additionalDocuments`
group, under a `virtual:` URI. From then on it is built and indexed like any
file, so every head resolves references into it.

## Steps

1. **Write the library in your language's own syntax.** Keep it as text, so
   your parser checks it against the grammar and a grammar change cannot leave
   it silently broken. Leave out any `project` header: a document that belongs
   to no project exports its declarations to every project, so models use the
   built-ins without a `requires`.

2. **Give it a URI that ends in your file extension.** A document finds its
   language by extension, so build the URI with
   `virtualUri(contributor, 'name.<ext>')` and export it as a constant, for
   code that needs to recognise the library later.

3. **Register it in a contribution:**

<!-- snippet-preamble
import {
   type AdditionalDocumentContribution,
   type AdditionalDocumentRegistry,
   type ServerSharedServices,
   virtualUri
} from '@hydranium/core';
import type { LangiumDocumentFactory } from '@hydranium/langium';
-->

```ts
export const STDLIB_URI = virtualUri('my-lang-builtin', 'primitives.my-lang');

const STDLIB_SOURCE = `type String {}
type Number {}
`;

export class StdlibContribution implements AdditionalDocumentContribution {
   protected readonly factory: LangiumDocumentFactory;

   constructor(services: ServerSharedServices) {
      this.factory = services.workspace.LangiumDocumentFactory;
   }

   registerAdditionalDocuments(registry: AdditionalDocumentRegistry): void {
      registry.register(this.factory.fromString(STDLIB_SOURCE, STDLIB_URI));
   }
}
```

4. **Bind it in your shared module**, under a key of your own:

<!-- snippet-preamble
import type { AdditionalDocumentContribution, ServerSharedServices } from '@hydranium/core';
declare const StdlibContribution: new (services: ServerSharedServices) => AdditionalDocumentContribution;
-->

```ts
export const mySharedModule = {
   additionalDocuments: {
      stdlib: (services: ServerSharedServices) => new StdlibContribution(services)
   }
};
```

5. **Check that a model can use it.** Write a model that references a
   built-in and validate it: the reference resolves. If it does not, look in
   the server log for a warning that an additional document matches no
   registered language; it means the URI's extension is wrong.

## Things to know

- **The library is not validated.** A diagnostic on a document nobody can edit
  could never be acted on. `validateVirtualDocuments` in
  `DocumentValidatorOptions` turns validation back on, if you want to check it
  during development.
- **Open it read-only in your editors.** A client can open the library, for
  example on go-to-definition, and an edit to it lives until the server
  restarts. Keeping it read-only is up to the client.
- **To recognise its content**, compare a document's URI with your exported
  constant, or check `isVirtualUri` for any document no file backs.

[Customizing services](../concepts/customizing-services.md#synthetic-content)
describes the other kind of built content, a single node built in code beside a
real declaration.
