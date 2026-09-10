/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The panel's own extension↔webview notifications, which are NOT the data head.
 *
 * The data head rides the same `Messenger` hop but carries whole JSON-RPC
 * messages and terminates at the data server (see
 * `@hydranium/example-order-flow-client`'s messenger channel). What is declared
 * here is the panel's *shell* protocol instead: which document to show, when the
 * webview is listening, when the socket behind the hop died, and how a
 * webview-side failure reaches a VS Code notification. None of that is a
 * data-head concern, so none of it belongs in the framework.
 *
 * **Compiled by BOTH tsconfigs**, which is why it is here rather than under
 * `src/webview/`: the extension host builds it to CommonJS in `out/` while
 * esbuild pulls the same source into the webview bundle. It must therefore stay
 * DOM-free and `vscode`-free — `vscode-messenger-common` is neutral, and the
 * `@hydranium/protocol` import is type-only and so erases entirely.
 */

import type { ResolvedMessage } from '@hydranium/protocol';
import type { NotificationType } from 'vscode-messenger-common';

/** Which document the panel should present, if any. */
export interface OrderFlowPanelDocument {
   /** Document to open, or `undefined` for "nothing selected yet". */
   readonly uri?: string;
   /** Label to show for it — the host knows how to shorten a workspace path. */
   readonly label?: string;
}

/** A webview-side failure, on its way to the only tier that can render it. */
export interface OrderFlowPanelError {
   /**
    * The failure exactly as `DataPort.reportError` hands it over: a complete
    * sentence plus the identity needed to render it in another language.
    *
    * Nothing needs flattening, which is the point — a `ResolvedMessage` is
    * structured-clone safe, so it crosses the hop unchanged. It travels
    * unrendered because the WEBVIEW is the wrong side to render on: a sandbox
    * knows no locale and holds no catalogue, while the host has both, so a
    * pre-rendered string would fix the language at the one end that cannot
    * choose it.
    */
   readonly reported: ResolvedMessage;
}

/**
 * Host → webview: present this document.
 *
 * Sent only after {@link ORDER_FLOW_PANEL_READY}. `vscode-messenger` posts into
 * the webview immediately, and the webview's own `Messenger` does not attach its
 * `window` listener until `start()` has run, so a notification sent before that
 * is dropped with no error — the panel then sits empty forever.
 */
export const ORDER_FLOW_PANEL_SET_DOCUMENT: NotificationType<OrderFlowPanelDocument> = {
   method: 'orderFlow/panel/setDocument'
};

/** Webview → host: `start()` has run, so it is safe to address the webview. */
export const ORDER_FLOW_PANEL_READY: NotificationType<void> = { method: 'orderFlow/panel/ready' };

/**
 * Host → webview: the relay's framed side is gone.
 *
 * `PostMessageChannel` has no `close()`, so a dead data server is otherwise
 * invisible to the webview, whose pending requests hang with no rejection —
 * `MessageRelay.onClose`'s own doc names doing nothing as the one wrong choice.
 * On this the webview disposes its session, which disposes the connection and
 * rejects everything in flight, and renders a disconnected state.
 */
export const ORDER_FLOW_PANEL_CONNECTION_LOST: NotificationType<void> = { method: 'orderFlow/panel/connectionLost' };

/**
 * Webview → host: surface this failure the way VS Code does.
 *
 * This is what makes `DataPort.reportError` real inside a sandbox that has no
 * `window.showErrorMessage` — without it the port's error sink would be a
 * `console.error` nobody opens, and a dead connection would present as an empty
 * form, which is precisely the confusion the port's doc warns about.
 */
export const ORDER_FLOW_PANEL_REPORT_ERROR: NotificationType<OrderFlowPanelError> = {
   method: 'orderFlow/panel/reportError'
};
