/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { OrderFlowPropertiesModel } from '@hydranium/example-order-flow-client/lib/data/order-flow-properties-model';
import { PropertiesForm } from '@hydranium/example-order-flow-client/lib/properties/properties-form';
import { PROPERTIES_CLOSE_FAILED, PROPERTIES_OPEN_FAILED } from '@hydranium/example-order-flow-client/lib/properties/properties-messages';
import { DataEvents, DataSession, describeError, resolve, type TransferElement } from '@hydranium/protocol';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { OrderFlowTheiaDataPort } from './order-flow-theia-data-port';

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
 * The order-flow properties panel as a Theia `PropertyViewContentWidget`.
 *
 * **A wiring job, not a form.** The DOM belongs to `PropertiesForm`, which is
 * shared verbatim with the VS Code webview and has no host coupling of its own;
 * the open/watch/write/reconcile policy belongs to `OrderFlowPropertiesModel`;
 * the transport belongs to {@link OrderFlowTheiaDataPort}. What this class adds
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

   @inject(OrderFlowTheiaDataPort) protected readonly port!: OrderFlowTheiaDataPort;

   protected form!: PropertiesForm;
   protected model!: OrderFlowPropertiesModel<OrderFlowTransferRoot>;
   /** The document currently open, so a repeated selection is not reloaded. */
   protected openUri?: string;

   @postConstruct()
   protected init(): void {
      this.id = OrderFlowPropertiesWidget.ID;
      this.title.label = 'Order Flow';
      this.addClass('order-flow-properties');
      this.node.tabIndex = 0;

      const events = new DataEvents<OrderFlowTransferRoot>();
      const session = new DataSession<OrderFlowTransferRoot>(this.port, events);
      this.model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session, events);

      const host = document.createElement('div');
      host.className = 'order-flow-properties-body';
      this.node.appendChild(host);
      // No diagnostic renderer: the server renders what it publishes, so this
      // host supplies a catalogue only for the messages the CLIENT tier raises,
      // which fire when the server is unreachable and it alone can word.
      this.form = new PropertiesForm(host, {
         setField: (name, value) => this.model.setField(name, value),
         reportError: (error, reported) => this.port.reportError(error, reported)
      });

      this.toDispose.push(this.model.onDidChange(() => this.render()));
      this.toDispose.push(this.model);
      this.toDispose.push(session);
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
    * reopen the document (and drop the server-side watch) on each focus.
    */
   showDocument(uri: string | undefined): void {
      if (uri === this.openUri) {
         return;
      }
      this.openUri = uri;
      if (!uri) {
         this.form.setTitle(undefined);
         void this.model
            .close()
            .catch((error: unknown) => this.port.reportError(error, resolve(PROPERTIES_CLOSE_FAILED, { detail: describeError(error) })));
         return;
      }
      this.form.setTitle(uri.substring(uri.lastIndexOf('/') + 1));
      this.form.setLoading(true);
      this.form.report('Loading…');
      this.model
         .open(uri)
         .then(() => {
            this.form.setLoading(false);
            // Render explicitly. The model fires its change synchronously inside
            // `open`, i.e. while `loading` is still true — harmless for a
            // document that has fields, but a root that genuinely has NONE would
            // otherwise have its suppressed empty render be the only one, and the
            // panel would keep showing the previous document's inputs.
            this.render();
            this.form.report('');
         })
         .catch((error: unknown) => {
            this.form.setLoading(false);
            this.port.reportError(error, resolve(PROPERTIES_OPEN_FAILED, { uri, detail: describeError(error) }));
            this.form.report(describeError(error), 'error');
         });
   }

   protected render(): void {
      this.form.setFields(this.model.fields);
      this.form.setDiagnostics(this.model.diagnostics);
   }
}
