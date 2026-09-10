/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The webview bundle's entry point: the sandbox end of the data head.
 *
 * The whole stack above the hop is host-invariant — the messenger channel
 * presents `postMessage` as a `PostMessageChannel`,
 * `createPostMessageTransport` turns that into a reader/writer pair,
 * `DataSession` owns readiness and reconnect over a `DataPort`, and
 * `OrderFlowPropertiesModel` owns the open/watch/write/reconcile policy. What
 * this file adds is only the two things a webview alone can do: acquire the VS
 * Code API, and draw.
 *
 * **Import discipline, both halves of which cost a debugging cycle when missed.**
 * `vscode-jsonrpc/browser` (in the port next door), because the package root
 * installs no runtime abstraction layer; and MODULE paths into
 * `@hydranium/example-order-flow-client` rather than its barrel, because the
 * barrel re-exports the GLSP diagram definition and its graph reaches CSS this
 * bundle has no loader for.
 */

import {
   ORDER_FLOW_PANEL_CONNECTION_LOST,
   ORDER_FLOW_PANEL_READY,
   ORDER_FLOW_PANEL_REPORT_ERROR,
   ORDER_FLOW_PANEL_SET_DOCUMENT
} from '../properties-panel-protocol';
import { PropertiesForm } from '@hydranium/example-order-flow-client/lib/properties/properties-form';
import { WebviewDataPort } from './properties-data-port';
import type {
   DomainModel,
   LayoutModel,
   ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-transfer/transfer-model';
import {
   createWebviewSideChannel,
   type WebviewMessengerLike
} from '@hydranium/example-order-flow-client/lib/data/order-flow-messenger-channel';
import { OrderFlowPropertiesModel } from '@hydranium/example-order-flow-client/lib/data/order-flow-properties-model';
import { PROPERTIES_OPEN_FAILED } from '@hydranium/example-order-flow-client/lib/properties/properties-messages';
import { DataEvents, DataSession, describeError, resolve, type DataPort, type ResolvedMessage } from '@hydranium/protocol';
import { HOST_EXTENSION, type MessageParticipant } from 'vscode-messenger-common';
import { Messenger, type VsCodeApi } from 'vscode-messenger-webview';

/** The union of transfer roots this workspace's three grammars produce. */
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

/**
 * Compile-time proof that the WEBVIEW-side `Messenger` satisfies
 * {@link WebviewMessengerLike}.
 *
 * Two interfaces and two assertions, one per side, because the two messengers are
 * not the same shape: the webview messenger's `onNotification` hands back the
 * messenger itself rather than a `Disposable`, and takes no `sender` option. A
 * single interface covering both would be false of the webview side, and nothing
 * but an assertion like this one would catch it.
 */
const _webviewMessengerConforms: (messenger: Messenger) => WebviewMessengerLike<MessageParticipant> = messenger => messenger;
void _webviewMessengerConforms;

/** Compile-time proof that the port still fits the framework's contract. */
const _portConforms: (port: WebviewDataPort) => DataPort = port => port;
void _portConforms;

/**
 * The webview host API, injected by VS Code into the sandbox's global scope.
 *
 * Declared rather than imported because there is nothing to import — it exists
 * only at runtime, and only inside a webview. `VsCodeApi` comes from
 * `vscode-messenger-webview` so the shape is the one the messenger will actually
 * use (it wants `getState`/`setState` as well as `postMessage`), which a
 * hand-narrowed structural stand-in got wrong.
 */
declare function acquireVsCodeApi(): VsCodeApi;

function main(): void {
   const root = document.getElementById('root');
   if (!root) {
      return;
   }

   // Held rather than passed straight through, because `setState` is the only
   // thing that survives a window reload. VS Code hands whatever was last stored
   // back to the extension's `WebviewPanelSerializer`, and after a reload the
   // EXTENSION HOST has restarted too — so the host's own memory of which
   // document was open is gone, and this is the only copy left.
   // `acquireVsCodeApi` may be called exactly once per webview, which is the
   // other reason to keep the reference.
   const vscodeApi = acquireVsCodeApi();
   const messenger = new Messenger(vscodeApi);
   // Forwarded rather than rendered: a webview knows no locale and has no
   // notification surface, so the host is the only tier that can do either. A
   // `ResolvedMessage` is structured-clone safe, so the hop costs nothing.
   const reportError = (error: unknown, reported: ResolvedMessage): void => {
      messenger.sendNotification(ORDER_FLOW_PANEL_REPORT_ERROR, HOST_EXTENSION, { reported });
   };

   const port = new WebviewDataPort(createWebviewSideChannel(messenger, HOST_EXTENSION), reportError);
   const events = new DataEvents<OrderFlowTransferRoot>();
   const session = new DataSession<OrderFlowTransferRoot>(port, events);
   const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session, events);

   const form = new PropertiesForm(root, {
      setField: (name, value) => model.setField(name, value),
      reportError
   });

   const render = (): void => {
      form.setFields(model.fields);
      form.setDiagnostics(model.diagnostics);
   };
   model.onDidChange(render);

   messenger.onNotification(ORDER_FLOW_PANEL_SET_DOCUMENT, document_ => {
      form.setTitle(document_.label);
      // Bound to a local, so the failure path below can name it: narrowing a
      // property does not survive into a callback, and the message's `{uri}`
      // parameter takes no `undefined`.
      const uri = document_.uri;
      if (!uri) {
         return;
      }
      // Remember it for a reload, BEFORE the load rather than after: a reload
      // during a slow open should still come back to the right document.
      vscodeApi.setState(document_);
      form.setLoading(true);
      form.report('Loading…');
      model
         .open(uri)
         .then(() => {
            form.setLoading(false);
            // Render again explicitly. The model fires its change synchronously
            // inside `open`, i.e. while `loading` is still true — harmless for a
            // document that has fields, but a root that genuinely has NONE would
            // otherwise have its (suppressed) empty render be the only one, and
            // the panel would keep showing the previous document's inputs.
            render();
            form.report('');
         })
         .catch((error: unknown) => {
            form.setLoading(false);
            reportError(error, resolve(PROPERTIES_OPEN_FAILED, { uri, detail: describeError(error) }));
            form.report(describeError(error), 'error');
         });
   });

   messenger.onNotification(ORDER_FLOW_PANEL_CONNECTION_LOST, () => {
      // Fires the port's `onDispose`, which makes `DataSession` drop its
      // generation and dispose the connection — that is what rejects the
      // requests that would otherwise hang, since the clone pipe still looks
      // open from in here.
      port.connectionLost();
      form.setDisconnected();
   });

   // `start()` attaches the `window` message listener. Nothing arrives before
   // it, and the host must not address the webview until after it, which is what
   // the ready notification below is for. Registering the handlers first means
   // no notification can land between `start()` and the registrations.
   messenger.start();
   messenger.sendNotification(ORDER_FLOW_PANEL_READY, HOST_EXTENSION);
}

main();
