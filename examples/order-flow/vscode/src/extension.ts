/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * VS Code shell for the order-flow example.
 *
 * All three heads: the LSP head as a language client, the data head under the
 * properties panel, and the GLSP head under the `.process` diagram editor. The
 * adapter is hand-rolled: the framework ships Theia client packages and no
 * VS Code equivalents, so a VS Code host supplies this layer itself.
 *
 * Node extension host only. Both socket heads are reached with `net`, and the
 * language server is forked, so this cannot run in a web extension host.
 */

import { OrderFlowPropertiesPanel } from './properties-panel';
import { ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE, OrderFlowProcessDiagramEditorProvider } from './process-diagram-editor';
import { OrderFlowGlspVscodeServer } from './process-diagram-server';
import { GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
// The MODULE, not a barrel: this package is a VS Code extension with no public
// API surface of its own, so the servers extension is consumed by path.
import { startOrderFlowLanguageClient } from '@hydranium/example-order-flow-vscode-servers/out/language-client';
import type { ExtensionContext } from 'vscode';
import { commands, window } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { ORDER_FLOW_PORT_COMMANDS, awaitPort } from './head-ports';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
   // The server launch, and the host commands that expose each head's port, live
   // in the servers-only extension a Theia app sideloads. Sharing the launch is
   // what keeps the two hosts from drifting on `documentSelector` or the file
   // watcher — a divergence there changes which documents the server ever sees
   // and fails silently in one host only.
   // Bound to a local first, so the two heads below see a non-optional client;
   // the module-level `client` exists only for `deactivate`.
   const running = await startOrderFlowLanguageClient(context);
   client = running;

   // The GLSP head, and the connector that bridges it to every diagram webview.
   //
   // No `messenger` option, and that omission is load-bearing rather than
   // incidental: `GlspVscodeConnector` defaults it to
   // `new Messenger({ ignoreHiddenViews: false })`, and `GlspEditorProvider`
   // forwards that instance to each `WebviewEndpoint` — which would otherwise
   // default-construct one with `ignoreHiddenViews: true` and drop every
   // host→webview notification for a hidden diagram tab. Passing a messenger here
   // without repeating the option would reintroduce exactly that, which is the
   // hazard the properties panel's own doc comment describes.
   const glspServer = new OrderFlowGlspVscodeServer({
      clientId: 'order-flow-glsp',
      clientName: 'Order Flow',
      findPort: () => awaitPort(running, ORDER_FLOW_PORT_COMMANDS.glsp)
   });
   const glspConnector = new GlspVscodeConnector({ server: glspServer, logging: false });
   context.subscriptions.push(glspServer, glspConnector);
   // `start()` opens the socket, so it runs the port poll. Not awaited: a user who
   // never opens a diagram should not pay for it, and a failure here must not take
   // the language client and the properties panel down with it. Nothing races —
   // `GlspVscodeConnector.registerClient` awaits `server.glspClient`, which is
   // gated on readiness, so a diagram opened while this is still settling waits.
   //
   // The failure is reported off `onReady`, NOT off `start()`: `start()` catches
   // its own error and routes it into the readiness deferred, so it resolves even
   // when the server never came up and a `.catch` on it is dead code. Attaching
   // here is also what keeps the rejected deferred from surfacing as an unhandled
   // rejection when no diagram is ever opened to await it.
   void glspServer.start();
   void glspServer.onReady.catch((error: unknown) => {
      void window.showErrorMessage(`Order Flow diagram unavailable: ${error instanceof Error ? error.message : String(error)}`);
   });
   context.subscriptions.push(
      window.registerCustomEditorProvider(
         ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE,
         new OrderFlowProcessDiagramEditorProvider(glspConnector, context.extensionUri),
         {
            // The diagram holds a live GLSP session per view. Letting VS Code tear
            // the webview down when the tab is hidden would drop it and re-run the
            // whole handshake on every tab switch.
            webviewOptions: { retainContextWhenHidden: true },
            // One editor per document: a second view on the same `.process` would
            // register a second GLSP client for one source model, and the two would
            // race each other's submits.
            supportsMultipleEditorsPerDocument: false
         }
      )
   );

   // The properties panel. It discovers the data-server port through the same
   // `awaitPort` poll the diagram head uses — per connection generation, not
   // once, because a restarted language server binds a fresh ephemeral port.
   const properties = new OrderFlowPropertiesPanel({
      extensionUri: context.extensionUri,
      findPort: () => awaitPort(running, ORDER_FLOW_PORT_COMMANDS.dataServer),
      // One messenger for both heads. The panel requires `ignoreHiddenViews: false`,
      // which is exactly what `GlspVscodeConnector` defaults to — the diagram's
      // requirement and the panel's are one requirement, and this is the line that
      // makes that visible.
      messenger: glspConnector.messenger
   });
   context.subscriptions.push(
      { dispose: () => properties.dispose() },
      // Before anything else the panel does: a window reload hands the restored
      // tab only to a registered serializer, and with none it comes back blank
      // forever. Registering during activation is what makes the restore land on
      // a wired panel instead of a dead one.
      properties.registerSerializer(),
      commands.registerCommand('order-flow.properties.show', () => {
         properties.open();
         // Seed it with whatever is active NOW: `open` reveals the panel without
         // stealing focus, but no editor-change event fires for the document the
         // user was already in, so without this the panel would stay empty until
         // they switched files.
         properties.followActiveEditor(window.activeTextEditor?.document);
      }),
      window.onDidChangeActiveTextEditor(editor => properties.followActiveEditor(editor?.document))
   );
}

export async function deactivate(): Promise<void> {
   await client?.stop();
   client = undefined;
}
