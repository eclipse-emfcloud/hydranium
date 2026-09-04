/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The properties panel's extension-host half: a webview, a messenger, a relay.
 *
 * Everything below this file is host-invariant — `relayToPostMessageChannel`
 * pumps the socket, `createExtensionSideChannel` presents the `Messenger` as a
 * `PostMessageChannel`, `connectDataHead` joins them — so what is left here is
 * only what needs `vscode`: creating the panel, telling the webview which
 * document to show, and turning a webview-side failure into a notification the
 * user can see.
 *
 * **It shares GLSP's `Messenger` rather than owning one.** The messenger arrives
 * through {@link OrderFlowPropertiesPanelOptions.messenger} rather than being
 * reached for, so the panel knows nothing about `GlspVscodeConnector` — the shell
 * composes them, and the panel would work just as well handed a standalone
 * `Messenger`.
 *
 * **`ignoreHiddenViews: false` is the whole cost of sharing, and it is not
 * optional.** `vscode-messenger` defaults it to TRUE, and
 * `sendNotificationToWebview` then returns early — logging at debug level and
 * nothing else — whenever `!view.visible`. The data head's RESPONSES travel
 * host→webview as notifications, so with the default every reply from the data
 * server is dropped for as long as the panel tab is not the visible one in its
 * group, and the webview's pending requests hang with no rejection. That is
 * precisely the failure `MessageRelay.onClose` exists to prevent, reintroduced
 * by a library default.
 *
 * `GlspVscodeConnector` happens to default its messenger to
 * `new Messenger({ ignoreHiddenViews: false })`, which is why sharing it is safe
 * with the pinned `@eclipse-glsp/vscode-integration` — but an adopter that hands
 * the connector a messenger of its own has to repeat the option, and nothing
 * detects the omission. `extension.ts` is where that constraint is honoured.
 */

import { connectDataHead, type GlspMessenger, type GlspParticipant } from './data-hop';
import {
   ORDER_FLOW_PANEL_CONNECTION_LOST,
   ORDER_FLOW_PANEL_READY,
   ORDER_FLOW_PANEL_REPORT_ERROR,
   ORDER_FLOW_PANEL_SET_DOCUMENT,
   type OrderFlowPanelDocument
} from './properties-panel-protocol';
import type { MessageRelay } from '@hydranium/protocol';
import * as vscode from 'vscode';
// Type-only: the panel receives the shell's messenger instead of constructing
// one, so nothing here reaches the value.
import type { Messenger } from 'vscode-messenger';

/**
 * Compile-time proof that the messenger the shell shares is a plain
 * `vscode-messenger` `Messenger`.
 *
 * `GlspMessenger` is derived from `GlspVscodeConnector['messenger']`, so a GLSP
 * bump that reshaped the messenger — a wrapper, a narrowed facade — would break
 * this line rather than a webview at runtime. The direction is the one that
 * matters here: the question is whether GLSP's instance satisfies the `Messenger`
 * API this panel calls, not whether an instance of ours would satisfy GLSP's
 * parameter type.
 */
const _glspMessengerIsAMessenger: (messenger: GlspMessenger) => Messenger = messenger => messenger;
void _glspMessengerIsAMessenger;

/** The language ids whose documents this panel can present. */
const ORDER_FLOW_LANGUAGES = new Set(['order-flow-domain', 'order-flow-process', 'order-flow-layout']);

/** What {@link OrderFlowPropertiesPanel.open} needs from the extension. */
export interface OrderFlowPropertiesPanelOptions {
   readonly extensionUri: vscode.Uri;
   /**
    * Resolve the data server's listening port. Passed straight through to the
    * relay, which calls it once per connection generation, so a restarted
    * server is re-discovered rather than cached.
    */
   readonly findPort: () => Promise<number>;
   /**
    * The messenger this panel registers its webview on.
    *
    * **Must have been constructed with `ignoreHiddenViews: false`** — see the
    * class doc for what the default costs. Taken as a parameter rather than
    * constructed here so the shell can share one messenger across the data and
    * diagram heads; the panel neither creates nor disposes it.
    */
   readonly messenger: GlspMessenger;
}

/**
 * A document-scoped properties view over the live data head.
 *
 * Single-instance by design: it follows the active editor rather than being
 * opened per document, which matches the model behind it —
 * `OrderFlowPropertiesModel` is document-scoped, and for the reasons its own doc
 * gives (a transfer element carries no id, so the only cross-rebuild address is a
 * positional path a foreign insert invalidates), not as a simplification.
 */
export class OrderFlowPropertiesPanel {
   static readonly VIEW_TYPE = 'orderFlow.propertiesPanel';

   protected panel?: vscode.WebviewPanel;
   protected messenger?: Messenger;
   protected participant?: GlspParticipant;
   protected relay?: MessageRelay;
   protected subscriptions: vscode.Disposable[] = [];
   /**
    * The document to present once the webview reports ready, and the record of
    * what it is currently showing. Held here rather than read from
    * `window.activeTextEditor` on demand because the active editor at the moment
    * the webview finishes loading is the PANEL, not the document that opened it.
    */
   protected pending?: OrderFlowPanelDocument;
   protected ready = false;

   constructor(protected readonly options: OrderFlowPropertiesPanelOptions) {}

   /**
    * Show the panel, creating it on first use.
    *
    * Reveals without stealing focus, so invoking it from the palette leaves the
    * cursor in the document the user was editing — which is also what keeps
    * {@link followActiveEditor} from immediately being handed the panel itself.
    */
   open(): void {
      if (this.panel) {
         this.panel.reveal(vscode.ViewColumn.Beside, true);
         return;
      }
      this.create();
   }

   /**
    * Point the panel at `document` if it is one of ours, otherwise leave it
    * alone.
    *
    * Deliberately not blanking on a foreign editor: a properties view that
    * empties itself when the user clicks a settings tab or an output channel
    * reads as broken, and the panel's own webview counts as a foreign editor
    * every time it is revealed.
    */
   followActiveEditor(document: vscode.TextDocument | undefined): void {
      const panelDocument = toPanelDocument(document);
      if (panelDocument) {
         this.show(panelDocument);
      }
   }

   dispose(): void {
      this.panel?.dispose();
   }

   /** Send `document` to the webview, or hold it until the webview is ready. */
   protected show(document: OrderFlowPanelDocument): void {
      this.pending = document;
      if (this.ready && this.messenger && this.participant) {
         this.messenger.sendNotification(ORDER_FLOW_PANEL_SET_DOCUMENT, this.participant, document);
      }
   }

   /**
    * Re-adopt a panel VS Code restored after a window reload.
    *
    * **Without this the restored tab is permanently blank, and that is a defect
    * no test reaches.** VS Code remembers the tab across a reload and hands it
    * back only to a registered {@link vscode.WebviewPanelSerializer}; with none,
    * the panel comes back with no HTML, no messenger and no relay, and nothing
    * ever sets them — a panel that looks open and is dead. Registered from
    * `activate` so it is in place before any restore fires.
    *
    * Two differences from a freshly created panel, both accepted rather than
    * worked around:
    *
    * - **`retainContextWhenHidden` cannot be re-applied.** It is a creation-time
    *   `WebviewPanelOptions` field, and a restored panel's is fixed. So hiding a
    *   restored panel tears its webview down and revealing it re-runs the
    *   bootstrap. That degrades correctly rather than breaking: the fresh page
    *   sends `ready` again, this class re-sends the pending document, and the new
    *   `DataSession` opens a second connection generation over the still-live
    *   relay — the same path `connectionLost` exercises.
    * - **`webview.options` ARE re-applied** here, because script permission and
    *   the local resource root are not restored with the tab.
    */
   registerSerializer(): vscode.Disposable {
      return vscode.window.registerWebviewPanelSerializer(OrderFlowPropertiesPanel.VIEW_TYPE, {
         deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown): Promise<void> => {
            // **`state` is the ONLY memory of which document was open**, and
            // ignoring it leaves the restored panel saying "No Order Flow
            // document selected". A window reload restarts the EXTENSION HOST
            // too, so `pending` is empty on this side; what survives is whatever
            // the webview last handed to `setState`. The active editor is a
            // fallback rather than the primary source, because the editor VS
            // Code restores need not be the document the panel was showing.
            this.pending = restoredDocument(state) ?? this.pending ?? activeOrderFlowDocument();
            if (this.panel) {
               // Single-instance by design, and a reload can race an `open()`.
               // Dropping the restored duplicate is the only choice that leaves
               // one live panel rather than two halves of one.
               panel.dispose();
               return;
            }
            panel.webview.options = {
               enableScripts: true,
               localResourceRoots: [
                  vscode.Uri.joinPath(this.options.extensionUri, 'out'),
                  vscode.Uri.joinPath(this.options.extensionUri, 'media')
               ]
            };
            this.adopt(panel);
         }
      });
   }

   protected create(): void {
      this.adopt(
         vscode.window.createWebviewPanel(
            OrderFlowPropertiesPanel.VIEW_TYPE,
            'Order Flow Properties',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
               enableScripts: true,
               // The panel holds a live data session and a relay. Letting VS Code
               // tear the webview down when it is hidden would drop both and
               // silently reopen a second socket on the next reveal.
               retainContextWhenHidden: true,
               localResourceRoots: [
                  vscode.Uri.joinPath(this.options.extensionUri, 'out'),
                  vscode.Uri.joinPath(this.options.extensionUri, 'media')
               ]
            }
         )
      );
   }

   /** Wire `panel` up as this instance's live panel — created or restored. */
   protected adopt(panel: vscode.WebviewPanel): void {
      this.panel = panel;

      // The shell's messenger, shared with the diagram head. Not constructed and
      // not disposed here — the panel is one participant on it, and a second
      // panel generation (a reopen, or a restore after a window reload) simply
      // registers again. `registerViewContainer` drops its entry on the panel's
      // own `onDidDispose`, so the churn does not accumulate.
      //
      // `ignoreHiddenViews: false` is correct rather than merely convenient:
      // the guard is a proxy for "is the webview alive", and
      // `retainContextWhenHidden` above makes it alive while hidden, so
      // `postMessage` really does deliver. (Upstream's own comment on the sibling
      // request path claims the guard already accounts for
      // `retainContextWhenHidden`; the code checks only `view.visible`.)
      const messenger = this.options.messenger;
      this.messenger = messenger;
      // Register BEFORE the html assignment below, which is what starts the
      // webview loading: the participant has to exist before the webview's first
      // notification can be routed.
      this.participant = messenger.registerWebviewPanel(panel);
      const participant = this.participant;

      this.subscriptions.push(
         messenger.onNotification(
            ORDER_FLOW_PANEL_READY,
            () => {
               this.ready = true;
               if (this.pending) {
                  messenger.sendNotification(ORDER_FLOW_PANEL_SET_DOCUMENT, participant, this.pending);
               }
            },
            { sender: participant }
         ),
         messenger.onNotification(
            ORDER_FLOW_PANEL_REPORT_ERROR,
            error => {
               void vscode.window.showErrorMessage(`Order Flow properties — ${error.context}: ${error.message}`);
            },
            { sender: participant }
         ),
         panel.onDidDispose(() => this.release())
      );

      this.relay = connectDataHead({
         messenger,
         webview: participant,
         findPort: this.options.findPort,
         onWebviewDisposed: listener => panel.onDidDispose(listener),
         reportError: (error, context) => {
            void vscode.window.showErrorMessage(`Order Flow properties — ${context}: ${describe(error)}`);
         }
      });

      // The framed side dying is invisible to the webview, so tell it. Doing
      // nothing here is what `MessageRelay.onClose` names as the one wrong
      // choice: the webview's pending requests would hang with no rejection.
      // Automatic re-discovery of a restarted server's port is deliberately not
      // attempted here: the panel tells the webview and asks the user to reopen,
      // rather than re-resolving the port and re-relaying behind their back.
      this.subscriptions.push(
         this.relay.onClose(() => {
            if (this.ready) {
               messenger.sendNotification(ORDER_FLOW_PANEL_CONNECTION_LOST, participant);
            }
            void vscode.window.showWarningMessage(
               'Order Flow properties: the data server connection closed. Reopen the panel to reconnect.'
            );
         })
      );

      panel.webview.html = this.render(panel.webview);
   }

   /** Drop everything the panel owns. Called from the webview's own dispose. */
   protected release(): void {
      for (const subscription of this.subscriptions) {
         subscription.dispose();
      }
      this.subscriptions = [];
      this.relay?.dispose();
      this.relay = undefined;
      this.messenger = undefined;
      this.participant = undefined;
      this.panel = undefined;
      this.ready = false;
      // `pending` survives on purpose: reopening the panel should come back to
      // the document the user was last looking at.
   }

   /**
    * The webview document.
    *
    * **A nonce for the script and `webview.cspSource` for the stylesheet, which
    * is VS Code's own sample shape rather than an invented one.** The tighter
    * looking alternative — an inline `<style nonce>` with `style-src` listing
    * only that nonce — governs EVERY style in the document, including the
    * theme-variable stylesheet the host injects into the webview, which carries
    * no nonce of ours. Losing it would leave every `--vscode-*` variable
    * undefined and the panel unthemed, so the stylesheet is a real file served
    * from `media/`.
    *
    * No `'unsafe-inline'` and no `'unsafe-eval'`, unlike GLSP's own example —
    * that one needs both for sprotty; this panel is plain DOM and needs neither.
    */
   protected render(webview: vscode.Webview): string {
      const script = webview.asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, 'out', 'webview', 'properties.js'));
      const style = webview.asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, 'media', 'properties.css'));
      const nonce = makeNonce();
      return `<!DOCTYPE html>
<html lang="en">
   <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta
         http-equiv="Content-Security-Policy"
         content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
      />
      <title>Order Flow Properties</title>
      <link rel="stylesheet" href="${style}" />
   </head>
   <body>
      <div id="root"></div>
      <script nonce="${nonce}" src="${script}"></script>
   </body>
</html>`;
   }
}

/**
 * The document a restored panel was showing, if the persisted state names one.
 *
 * A typeguard rather than a cast: `state` crosses a serialization boundary and
 * comes back as whatever was there when the window closed, including from an
 * older version of this extension. Anything unrecognised is treated as absent.
 */
function restoredDocument(state: unknown): OrderFlowPanelDocument | undefined {
   if (typeof state !== 'object' || state === null) {
      return undefined;
   }
   const { uri, label } = state as { uri?: unknown; label?: unknown };
   if (typeof uri !== 'string') {
      return undefined;
   }
   return { uri, label: typeof label === 'string' ? label : undefined };
}

/** `document` as the panel addresses it, or `undefined` if it is not one of ours. */
function toPanelDocument(document: vscode.TextDocument | undefined): OrderFlowPanelDocument | undefined {
   if (!document || !ORDER_FLOW_LANGUAGES.has(document.languageId)) {
      return undefined;
   }
   return { uri: document.uri.toString(), label: vscode.workspace.asRelativePath(document.uri) };
}

/** The active editor's document, if it is one of ours — the restore fallback. */
function activeOrderFlowDocument(): OrderFlowPanelDocument | undefined {
   return toPanelDocument(vscode.window.activeTextEditor?.document);
}

/** Flatten an unknown throw for a user-facing message. */
function describe(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

/** A per-load CSP nonce. Not a secret — it only has to be unguessable per document. */
function makeNonce(): string {
   const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
   let nonce = '';
   for (let i = 0; i < 32; i++) {
      nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
   }
   return nonce;
}
