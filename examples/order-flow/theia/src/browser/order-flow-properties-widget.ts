/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { PropertiesDocuments } from '@hydranium/example-order-flow-client/lib/properties/properties-documents';
import { PropertiesForm } from '@hydranium/example-order-flow-client/lib/properties/properties-form';
import { renderFrameworkMessage, type ResolvedMessage, type TransferElement } from '@hydranium/protocol';
import { nls } from '@theia/core/lib/common/nls';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { OrderFlowDataConnection } from './order-flow-data-connection';

/**
 * The transfer root, left at the framework's own bound.
 *
 * The VS Code webview names the concrete `DomainModel | LayoutModel |
 * ProcessModel` union; this panel deliberately does not, because it never
 * touches a typed property of the root. `OrderFlowPropertiesModel` derives its
 * editable fields from whatever own string properties the root has — so naming
 * a grammar here would buy no type-safety and would put the generated server
 * package in a frontend module's import graph for a type that erases.
 */
type OrderFlowTransferRoot = TransferElement;

/**
 * The label of this panel's session on the data head. `createSession` mints the
 * id from it, the label plus a random UUID, so each instance is its own
 * participant: the id keys the server's per-`(uri, clientId)` open and watch,
 * and is the echo key an inbound `onDocumentUpdated` is matched against.
 */
const ORDER_FLOW_PROPERTIES_SESSION_LABEL = 'order-flow-theia-properties';

/**
 * The order-flow properties panel as a Theia `PropertyViewContentWidget`.
 *
 * **A wiring job, not a form.** The DOM belongs to `PropertiesForm`, which is
 * shared verbatim with the VS Code webview and has no host coupling of its own.
 * The document switch belongs to `PropertiesDocuments`, the
 * open/watch/write/reconcile policy to `WorkingCopy`, which
 * `OrderFlowPropertiesModel` extends, and the transport to
 * {@link OrderFlowDataConnection}. What this class adds
 * is what only a Theia widget can do: own a node, follow the selection Theia
 * hands it, and stay alive across selection changes.
 *
 * **One instance, one stable id, and that is required rather than tidy.**
 * Theia's `PropertyViewWidget.replaceContentWidget` compares the incoming
 * widget's `id` against the mounted one and only re-attaches when they differ —
 * so a provider that built a fresh widget per selection would detach and
 * rebuild the whole panel on every click, losing focus and the connection with
 * it. Returning the same widget makes `updatePropertyViewContent` the update
 * path, which is what Theia's own providers do.
 *
 * It does NOT implement `PropertyViewContentWidget` by `implements` clause:
 * that interface is structural over `Widget`, and `BaseWidget` plus the method
 * below satisfies it. The provider's return type is where the check lands.
 */
@injectable()
export class OrderFlowPropertiesWidget extends BaseWidget {
   static readonly ID = 'order-flow-properties-widget';

   @inject(OrderFlowDataConnection) protected readonly dataConnection!: OrderFlowDataConnection;

   protected form!: PropertiesForm;
   protected documents!: PropertiesDocuments<OrderFlowTransferRoot>;
   /**
    * Renders every sentence this panel shows, the form's and a failure's own,
    * through the same catalogue the data port renders a failure through, so a
    * sentence the panel draws and one it raises come from one authority.
    */
   protected readonly renderMessage = (message: ResolvedMessage): string => renderFrameworkMessage(message, nls.localization?.translations);

   @postConstruct()
   protected init(): void {
      this.id = OrderFlowPropertiesWidget.ID;
      this.title.label = 'Order Flow';
      this.addClass('order-flow-properties');
      this.node.tabIndex = 0;

      const session = this.dataConnection.createSession(ORDER_FLOW_PROPERTIES_SESSION_LABEL);

      const host = document.createElement('div');
      host.className = 'order-flow-properties-body';
      this.node.appendChild(host);
      // No diagnostic renderer: the server renders what it publishes, so this
      // host supplies a catalogue only for the messages the CLIENT tier raises,
      // which fire when the server is unreachable and it alone can word.
      this.form = new PropertiesForm(
         host,
         {
            setField: (name, value) => this.documents.setField(name, value),
            reportError: (error, reported) => this.dataConnection.reportError(error, reported)
         },
         { renderMessage: this.renderMessage }
      );
      this.documents = new PropertiesDocuments<OrderFlowTransferRoot>(session, this.dataConnection.events, this.form, {
         reportError: (error, reported) => this.dataConnection.reportError(error, reported),
         renderMessage: this.renderMessage
      });

      // The session only. The connection is shared and outlives this widget.
      // Ended once the writes have answered, since a write sent as the session
      // ends is never sent. Not on the close, whose request a server that never
      // answers leaves pending.
      this.toDispose.push({
         dispose: () => {
            const written = this.documents.whenWritesSettled();
            // A close that fails is not reported, as on window close the
            // connection ends first and the panel is gone.
            void this.documents.dispose();
            void written.then(() => session.dispose());
         }
      });
   }

   /**
    * Required by `PropertyViewContentWidget`, and deliberately a no-op:
    * {@link showDocument} is the update path, driven by the provider's
    * `updateContentWidget`.
    *
    * The signature carries a `PropertyDataService` first, which this widget takes
    * no part in: that abstraction exists so Theia's tree-based property widget can
    * be fed by pluggable data services, and this panel owns its own model over the
    * data head instead. Both parameters are accepted and ignored so the structural
    * type still matches.
    */
   updatePropertyViewContent(_propertyDataService?: unknown, selection?: unknown): void {
      void selection;
   }

   /**
    * Open `uri`, or clear the panel when there is none.
    *
    * Re-selecting the document already open is a no-op rather than a reload —
    * the forwarder republishes a `GlspSelection` on every diagram focus change,
    * so without this guard clicking back into the diagram would close and
    * reopen the document (and drop the server-side watch) on each focus. A
    * document whose copy follows none, as after a deletion, loads again, but
    * not after a failed open.
    */
   showDocument(uri: string | undefined): void {
      if (uri !== this.documents.current?.uri) {
         this.form.setTitle(uri && uri.substring(uri.lastIndexOf('/') + 1));
      }
      this.documents.show(uri);
   }
}
