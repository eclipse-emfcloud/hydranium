/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { commands, type ExtensionContext } from 'vscode';

/**
 * Register a host command per socket head that answers the head's port, keyed
 * command id to the LSP request the server publishes the port under.
 *
 * A Theia app that sideloads the extension reaches each port through these
 * commands, since its backend has no language client of its own, and its
 * connection handler retries a command nobody registered forever.
 *
 * Each command hands back the request's promise and nothing else. Awaiting a
 * notification there would make the answer wait for a user to dismiss it,
 * which hangs the Theia backend with nothing logged.
 */
export function registerPortCommands(
   context: Pick<ExtensionContext, 'subscriptions'>,
   client: { sendRequest<R>(method: string): Promise<R> },
   portCommands: Readonly<Record<string, string>>
): void {
   for (const [commandId, request] of Object.entries(portCommands)) {
      context.subscriptions.push(commands.registerCommand(commandId, () => client.sendRequest<number>(request)));
   }
}
