/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ORDER_FLOW_DATA_SERVER_PORT_COMMAND, ORDER_FLOW_GLSP_PORT_COMMAND } from '@hydranium/example-order-flow-server';
import type { ExtensionContext } from 'vscode';
import { commands, workspace } from 'vscode';
import { LanguageClient, type LanguageClientOptions, type ServerOptions, TransportKind } from 'vscode-languageclient/node';

/**
 * Hosting the order-flow language server from a VS Code extension host, shared
 * by both shells that need it.
 *
 * **Shared rather than duplicated on purpose.** Two extensions launch this
 * server — the full VS Code shell, and the servers-only extension a Theia app
 * sideloads — and the launch is exactly the part whose drift is invisible: a
 * different `documentSelector` or file watcher changes which documents the
 * server ever sees, and nothing fails, the feature just goes quiet in one host
 * and not the other. The manifests still each declare their own languages and
 * grammars, because a VS Code extension has to be self-sufficient in its own
 * host; only the runtime launch is shared.
 */

const LANGUAGE_IDS = ['order-flow-domain', 'order-flow-process', 'order-flow-layout'] as const;

/** The client's name, which is also the Output channel `vscode-languageclient`
 *  creates. Theia-side integrations tail that channel by this exact string. */
export const ORDER_FLOW_LANGUAGE_CLIENT_NAME = 'Order Flow';

/** Host command ids the two socket-head ports are reachable under.
 *
 *  These are the ids a HOST executes, as distinct from the LSP request ids the
 *  server answers (`order-flow/glsp/port` and its sibling). A Theia backend
 *  connection handler reaches the port through `CommandService`, so the id it
 *  polls has to be one registered here — and because
 *  `AbstractSocketForwardingConnectionHandler` retries indefinitely by default, a
 *  mismatch never errors, it just never connects. */
export const ORDER_FLOW_HOST_PORT_COMMANDS = {
   dataServer: 'order-flow.port.dataServer',
   glsp: 'order-flow.port.glsp'
} as const;

/** LSP request id backing each host command in {@link ORDER_FLOW_HOST_PORT_COMMANDS}. */
const PORT_REQUESTS: Record<keyof typeof ORDER_FLOW_HOST_PORT_COMMANDS, string> = {
   dataServer: ORDER_FLOW_DATA_SERVER_PORT_COMMAND,
   glsp: ORDER_FLOW_GLSP_PORT_COMMAND
};

/**
 * Fork the language server, start the client, and expose both head ports as
 * host commands. Returns the started client so a caller can drive the other
 * heads off it.
 *
 * **The port commands are thin pass-throughs, and that is load-bearing.** They
 * hand back `sendRequest`'s promise and do nothing else — in particular they do
 * not `await` a notification. A VS Code message with no buttons resolves only
 * when the user dismisses it, so awaiting one here would make the command's
 * return value wait on a human; harmless in VS Code, where the diagram and the
 * form discover ports directly, and fatal in Theia, where the backend reaches
 * the port *through* this command and would hang forever with nothing logged.
 */
export async function startOrderFlowLanguageClient(context: ExtensionContext): Promise<LanguageClient> {
   // Resolved through the package layout, so this works both in the F5 dev host
   // (sibling workspace package) and from an installed VSIX (hoisted).
   const serverModule = require.resolve('@hydranium/example-order-flow-server/lib/main.js');

   // Fork + IPC: the extension host is Node, and IPC keeps stdout free — which
   // matters because the server's GLSP head routes its logs over the LSP
   // connection precisely to avoid corrupting a stdio transport.
   const serverOptions: ServerOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: {
         module: serverModule,
         transport: TransportKind.ipc,
         options: { execArgv: ['--nolazy', '--inspect=6009'] }
      }
   };

   const clientOptions: LanguageClientOptions = {
      documentSelector: LANGUAGE_IDS.map(language => ({ scheme: 'file', language })),
      synchronize: {
         fileEvents: workspace.createFileSystemWatcher('**/*.{domain,process,layout}')
      }
   };

   const client = new LanguageClient('order-flow', ORDER_FLOW_LANGUAGE_CLIENT_NAME, serverOptions, clientOptions);
   context.subscriptions.push(client);
   await client.start();

   for (const [head, request] of Object.entries(PORT_REQUESTS)) {
      const commandId = ORDER_FLOW_HOST_PORT_COMMANDS[head as keyof typeof ORDER_FLOW_HOST_PORT_COMMANDS];
      context.subscriptions.push(commands.registerCommand(commandId, () => client.sendRequest<number>(request)));
   }

   return client;
}
