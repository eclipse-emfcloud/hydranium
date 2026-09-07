/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Servers-only VS Code extension for the order-flow example: the language
 * server and its two head ports, and deliberately no UI.
 *
 * **This exists so a Theia app can sideload the server without inheriting a
 * second diagram editor.** A Theia product needs a VS Code extension host to
 * launch the language server and to answer the port commands its backend
 * connection handlers poll — but hosting the *full* VS Code shell also
 * registers that shell's `contributes.customEditors`, so `.process` ends up
 * with two Open With entries: the Theia GLSP diagram (which claims the
 * extension at priority 1001 and is therefore the default) and the VS Code
 * webview editor. Two editors for one file is a defect, not a feature, and
 * splitting the server hosting out of the shell is what avoids it. That is a
 * property of shipping both hosts at all, not a shortcut this example takes:
 * any codebase whose VS Code shell contributes an editor for the same files
 * its Theia app opens needs the same division.
 *
 * So the division is: this package owns hosting the server, the Theia packages
 * own the Theia UI, and `order-flow-vscode` owns the VS Code UI. Nothing here
 * contributes an editor, a view, or a command palette entry.
 */

import { startOrderFlowLanguageClient } from './language-client';
import type { ExtensionContext } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
   client = await startOrderFlowLanguageClient(context);
}

export async function deactivate(): Promise<void> {
   await client?.stop();
   client = undefined;
}
