# Add a data-server method

Use this when a non-LSP client needs one domain operation over the data head.
Do not add a method for a document lifecycle operation already provided by
`DataServer`; use `openModelDocument`, `updateModelDocument`,
`saveModelDocument`, and the watch methods for those jobs.

Heads: data

## The seam

Subclass `DataServer` only to add an adopter-owned method. List its name in
`additionalMethods`; the server registers framework and adopter handlers in one
namespace. On the client, use the same namespace and expose the complete
`DataClientProtocol` notification surface on that connection. The [RPC
reference](../../packages/protocol/src/rpc/README.md) explains the shared proxy
convention.

## Steps

1. Define the request and response shape, then implement it on a `DataServer`
   subclass. Use a domain operation rather than wrapping a lifecycle method:
   this example searches the shared index for all declarations with an exact
   name.

<!-- snippet-preamble
import type { ServerSharedServices } from '@hydranium/core';
import type { TransferElement } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc';
declare const connection: MessageConnection;
declare const shared: ServerSharedServices;
type AppRoot = TransferElement;
-->

```ts
import { DataServer } from '@hydranium/data-server';

class AppDataServer extends DataServer<AppRoot> {
   findDeclarations(args: { name: string; type?: string }): Array<{ name: string; type: string; uri: string }> {
      return this.services.workspace.IndexManager.getElementsByName(args.name, args.type).map(description => ({
         name: description.name,
         type: description.type,
         uri: description.documentUri.toString()
      }));
   }
}
```

2. Register the method beside the framework methods. Choose one prefix for the
   complete data connection and use that exact prefix on both ends.

<!-- snippet-preamble
import { DataServer } from '@hydranium/data-server';
import type { ServerSharedServices } from '@hydranium/core';
import type { TransferElement } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc';
declare const connection: MessageConnection;
declare const shared: ServerSharedServices;
type AppRoot = TransferElement;
declare const AppDataServer: new (connection: MessageConnection, shared: ServerSharedServices, options: {
   methodNamespace: string;
   additionalMethods: readonly string[];
}) => DataServer<AppRoot>;
-->

```ts
new AppDataServer(connection, shared, {
   methodNamespace: 'app/',
   additionalMethods: ['findDeclarations']
});
```

3. Declare the client contract and bind the framework notification methods on
   the same connection. `localMethods` must include the complete
   `DataClientProtocol` notification list so updates, saves, deletes, builds,
   and project changes still arrive.

<!-- snippet-preamble
import type { MessageConnection } from 'vscode-jsonrpc';
import type { TransferElement } from '@hydranium/protocol';
declare const connection: MessageConnection;
declare const client: DataClientProtocol<TransferElement>;
type AppRoot = TransferElement;
-->

```ts
import { createRpcProxy } from '@hydranium/protocol';
import { DATA_CLIENT_PROTOCOL_METHODS } from '@hydranium/protocol/data';
import type { DataClientProtocol, DataServerProtocol } from '@hydranium/protocol/data';

interface AppDataMethods {
   findDeclarations(args: { name: string; type?: string }): Promise<Array<{ name: string; type: string; uri: string }>>;
}

const app = createRpcProxy<DataServerProtocol<AppRoot> & AppDataMethods, DataClientProtocol<AppRoot>>(connection, {
   methodNamespace: 'app/',
   localTarget: client,
   localMethods: DATA_CLIENT_PROTOCOL_METHODS
});
const result = await app.findDeclarations({ name: 'Order' });
```

## How you know it worked

Run the real data-server protocol suite:

```sh
npm exec -w @hydranium/data-server -- vitest run test/data-server.test.ts -t "namespace and additionalMethods"
```

Also run the client connection test when the connection is shared with another
head:

```sh
npm exec -w @hydranium/protocol -- vitest run test/client/data-connection.test.ts
```

Assert a framework method still works, the custom method returns its typed
result, and a client using the wrong namespace gets a rejected request. The
failure shape for a missing `additionalMethods` entry is an unhandled wire
method, while a mismatched namespace is a routing failure; keep those
assertions separate.

## What this guide does not give

It does not replace the framework protocol, rename built-in methods, or define
a second data-server connection. If the operation is a lifecycle request, use
the built-in contract. If several heads share one connection, partition the
entire wire surface under one agreed namespace and include all method lists in
that composition.
