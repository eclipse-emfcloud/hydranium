/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The servers-only extension: it starts the Bookstore server and contributes no
// editor, view or command. A Theia app sideloads this one rather than the VS
// Code extension, whose diagram editors would give its files a second editor.

import { registerPortCommands } from '@hydranium/client-vscode/node';
import {
   BOOKSTORE_DATA_SERVER_HOST_COMMAND,
   BOOKSTORE_DATA_SERVER_PORT_COMMAND,
   BOOKSTORE_GLSP_SERVER_HOST_COMMAND,
   BOOKSTORE_GLSP_SERVER_PORT_COMMAND
} from '@hydranium/bookstore-protocol';
import type { ExtensionContext } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { startBookstoreLanguageClient } from './language-client.js';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
   client = await startBookstoreLanguageClient(context);

   // Each socket head's port as a host command, for a host with no language
   // client of its own. Not in the shared launch: VS Code throws on a second
   // registration of one id, so the VS Code extension beside this one would fail
   // to activate. A pass-through: awaiting anything else in it would hang a
   // Theia backend on a user dismissing a notification.
   registerPortCommands(context, client, {
      [BOOKSTORE_DATA_SERVER_HOST_COMMAND]: BOOKSTORE_DATA_SERVER_PORT_COMMAND,
      [BOOKSTORE_GLSP_SERVER_HOST_COMMAND]: BOOKSTORE_GLSP_SERVER_PORT_COMMAND
   });
}

export async function deactivate(): Promise<void> {
   await client?.stop();
   client = undefined;
}
