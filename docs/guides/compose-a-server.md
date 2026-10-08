# Compose a server by hand

Use this when you add Hydranium to a project `init` did not create. `init`
writes all of this for you; the
[bookstore example](../../examples/bookstore/README.md) is what it writes, and
its `server/src` is the reference for each step.

Heads: LSP · data · GLSP

## The seam

Hydranium's services are Langium services. You compose them with your
generated modules and your own, in one call, and then start each head you want
on the same shared services, so every head works on the same workspace.

## Steps

1. **Generate your language** with `langium-cli`, all grammars in one run: the
   AST reflection is a single shared service, so two separately generated
   packages would leave only the last one's types bound.

2. **Compose the services** with `createIntegrationServices`. It puts
   Langium's defaults, your generated modules, the framework's defaults, the
   head modules you pass in `extra`, and your own modules together in the
   right order. Your language module must bind a `Serializer`, the one service
   the framework cannot default:

<!-- snippet-preamble
import type { ServerAddedServices, ServerSharedServices } from '@hydranium/core';
import type { LspServerAddedServices, LspServerAddedSharedServices } from '@hydranium/core/lsp';
import type { DeepPartial, Module } from '@hydranium/langium';
import type { LangiumServices, PartialLangiumServices, PartialLangiumSharedServices } from '@hydranium/langium/lsp';
declare const MySerializer: new (services: MyServices) => ServerAddedServices['serializer']['Serializer'];
-->

```ts
import { createIntegrationServices, type ServerModuleContext } from '@hydranium/core';
import { createLspServerLanguageModule, createLspServerSharedModule } from '@hydranium/core/lsp';
import { EmptyFileSystem } from '@hydranium/langium';
import { DomainGeneratedModule, OrderFlowGeneratedSharedModule } from './generated/module.js';

export type MySharedServices = ServerSharedServices & LspServerAddedSharedServices;
export type MyServices = LangiumServices & ServerAddedServices & LspServerAddedServices & { shared: MySharedServices };

const MySharedModule: Module<MySharedServices, PartialLangiumSharedServices> = {};

const MyLanguageModule: Module<MyServices, PartialLangiumServices & DeepPartial<ServerAddedServices>> = {
   serializer: {
      Serializer: services => new MySerializer(services)
   }
};

export function createMyServices(context: Partial<ServerModuleContext> = {}) {
   const fullContext: ServerModuleContext = { ...EmptyFileSystem, ...context };
   return createIntegrationServices<ServerModuleContext, MySharedServices, MyServices>({
      context: fullContext,
      sharedModules: {
         generated: OrderFlowGeneratedSharedModule,
         adopter: MySharedModule,
         extra: [createLspServerSharedModule(fullContext)]
      },
      languageModules: {
         generated: DomainGeneratedModule,
         adopter: () => MyLanguageModule,
         extra: [createLspServerLanguageModule(fullContext)]
      }
   });
}
```

   A second grammar goes in `additionalLanguages`. Where each of your own
   bindings belongs is in
   [Customizing services](../concepts/customizing-services.md).

3. **Start the LSP head** on a connection, with the framework's
   `startLanguageServer` from `@hydranium/core/lsp` rather than Langium's: it
   fails the start when the LSP head's shared module is missing, which
   otherwise boots a server whose editor sync quietly does nothing.

4. **Start the data head** on a socket, and tell the client its port over the
   LSP connection, so the host can find it:

<!-- snippet-preamble
import type { ServerSharedServices } from '@hydranium/core';
import type { LspServerAddedSharedServices } from '@hydranium/core/lsp';
declare const shared: ServerSharedServices & LspServerAddedSharedServices;
-->

```ts
import { publishPortOnLspConnection, startSocketServer } from '@hydranium/core/node';
import { DataServer } from '@hydranium/data-server';

const dataServer = startSocketServer({ port: 0, logTag: 'DataServer', logger: shared.Logger }, dataConnection => {
   new DataServer(dataConnection, shared);
   return { dispose: () => undefined };
});
await dataServer.started;
if (dataServer.port !== undefined) {
   publishPortOnLspConnection(shared.lsp.Connection, 'my-lang.port.dataServer', dataServer.port);
}
```

   Log a failure to start or publish rather than swallowing it: otherwise the
   editor works while every data client waits for a port nobody announces.

5. **Start the GLSP head** on the same shared services, as in step 4 of
   [Make a diagram editable](editable-diagram.md).

## How you know it worked

Start the server from your editor, open a model, and break a reference: the
editor reports it. For a test that does the same, see
[Test your language](test-your-language.md); the scaffold's `services.test.ts`
checks that the composition boots.
