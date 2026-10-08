# Compose a server by hand

The shortest end-to-end composition done by hand: one generated Langium language
wired to the framework's `DataServer` head, talking JSON-RPC over an in-process
duplex pair. This is what `init` scaffolds for you; do it manually when you're
slotting the framework into an existing project. Swap the duplex for stdio or a
socket in a real deployment; nothing else changes. A head with several grammars
repeats step 1's language `inject` per grammar over the one shared tree — see
`createIntegrationServices` below, which is the shape the examples use.

```ts
import { DataServer } from '@hydranium/data-server';
import { createRpcProxy } from '@hydranium/protocol';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerProtocol
} from '@hydranium/protocol/data';
import { makeDuplexConnectionPair } from '@hydranium/protocol/testing/node';
import { bootstrapLangium, createServerSharedModule, createServerLanguageModule, type ServerModuleContext } from '@hydranium/core';
import { EmptyFileSystem, inject } from '@hydranium/langium';
import { createDefaultModule, createDefaultSharedModule } from '@hydranium/langium/lsp';
import { DomainGeneratedModule, OrderFlowGeneratedSharedModule } from './generated/module.js';
import type { DomainModel } from './generated/ast.js';

// 1. Build the Langium DI tree. The framework's `createServerSharedModule`
//    and `createServerLanguageModule` slot in as ordinary `inject(...)`
//    contributors — they're plain Langium modules, not a separate framework
//    factory layer. Order matters: framework defaults first, adopter
//    overrides last.
const ctx: ServerModuleContext = EmptyFileSystem;
const shared = inject(
   createDefaultSharedModule(ctx),
   OrderFlowGeneratedSharedModule,
   createServerSharedModule(ctx)
   // ...adopter shared module(s) here
);
const language = inject(
   createDefaultModule({ shared }),
   DomainGeneratedModule,
   createServerLanguageModule(ctx)
   // ...adopter language module(s) (must bind `serializer.Serializer`)
);
bootstrapLangium(shared, language);

// 2. Attach the data-server head to a `MessageConnection`. The constructor
//    self-registers request handlers, the outbound notification proxy, and
//    a connection-close teardown listener — no separate `start()` call.
const pair = makeDuplexConnectionPair();
new DataServer<DomainModel>(pair.left, shared);
pair.left.listen();
pair.right.listen();

// 3. Client side: typed proxy over the same wire. One `createRpcProxy`
//    call exposes the server surface outbound and binds `localClient`
//    inbound for push notifications (`onDocumentUpdated` /
//    `onDocumentSaved` / `onDocumentDirtyChanged` / `onDocumentDeleted` /
//    `onDocumentsBuilt` / `onProjectsChanged`).
const localClient: DataClientProtocol<DomainModel> = {
   onDocumentUpdated: event => console.log('updated:', event.document.uri),
   onDocumentSaved: () => {},
   onDocumentDirtyChanged: () => {},
   onDocumentDeleted: event => console.log('deleted:', event.uri),
   // Documents rebuilt that this client never watched — re-read anything
   // derived from them.
   onDocumentsBuilt: event => console.log('built:', event.uris.join(', ')),
   onProjectsChanged: () => {}
};
const proxy = createRpcProxy<DataServerProtocol<DomainModel>, DataClientProtocol<DomainModel>>(pair.right, {
   methodNamespace: DATA_SERVER_WIRE_PREFIX,
   localTarget: localClient,
   localMethods: DATA_CLIENT_PROTOCOL_METHODS
});

const response = await proxy.getModelDocument({ uri: 'file:///workspace/orders.domain' });
// `model` is absent when the server has no such document, so the answer is a
// shaped envelope rather than an error and the caller branches on it.
console.log(response.model ? response.model.root.declarations.length : 'no such document');
```

The pieces a new adopter discovers from the example:

- **Langium services**: `inject(...)`, `createDefaultSharedModule`, `createDefaultModule`.
- **Framework modules**: `createServerSharedModule` / `createServerLanguageModule` —
  Langium modules that bind framework-default slots; adopters compose them
  with their own modules to override.
- **Bootstrap**: `bootstrapLangium(shared, language)` — registers the
  language, asserts the framework's core slots are bound, and eagerly
  constructs the build-pipeline listeners (`DEFAULT_EAGER_SERVICES`;
  pass a third argument to override). No framework-specific facade —
  or use `createIntegrationServices(...)` to fold the whole
  inject-inject-bootstrap chain into one call.
- **Data-server head**: `new DataServer(connection, shared, options?)` — one
  call self-wires the wire surface against the shared services tree.
- **Typed RPC primitives**: `createRpcProxy` (client side — typed server
  proxy outbound plus inbound `localTarget` notification binding in one
  call) and `bindRpcMethods`, both in `@hydranium/protocol`, reusable for
  adopters' own protocol heads. The data-head method names and wire prefix
  come from `@hydranium/protocol/data` (`DATA_SERVER_WIRE_PREFIX`,
  `DATA_CLIENT_PROTOCOL_METHODS`).
- **Transport**: vscode-jsonrpc `MessageConnection` is the only wire
  abstraction — `makeDuplexConnectionPair` (testing-only) or
  `createMessageConnection(reader, writer, logger)` for stdio / sockets in
  production.

## A production-shaped version

`examples/order-flow/server/` composes all three heads on one shared workspace
in `src/main.ts`: LSP through `startLanguageServer`, the data server on a socket
whose port is published over the LSP connection, and the GLSP head alongside.
