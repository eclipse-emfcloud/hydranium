/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { OrderFlowPropertiesModel } from '@hydranium/example-order-flow-client/lib/data/order-flow-properties-model';
import { describeFailure, PropertiesForm } from '@hydranium/example-order-flow-client/lib/properties/properties-form';
import {
   PROPERTIES_CLOSE_FAILED,
   PROPERTIES_LOADING,
   PROPERTIES_OPEN_FAILED
} from '@hydranium/example-order-flow-client/lib/properties/properties-messages';
import {
   type DataEvents,
   type DataSession,
   renderFrameworkMessage,
   resolve,
   type ResolvedMessage,
   type TransferElement
} from '@hydranium/protocol';
import { requireElement } from './dom.js';
import { pageTranslations } from './page-nls.js';

/**
 * The label of this panel's session on the data head. `createSession` mints the
 * id from it, so the panel's id differs from the page's own session's: the
 * server keys every open and watch per `(uri, clientId)` and matches an inbound
 * update against it to decide whether the change is this participant's own
 * echo.
 */
export const PROPERTIES_SESSION_LABEL = 'order-flow-browser-properties';

/**
 * The transfer root, left at the framework's own bound.
 *
 * `OrderFlowPropertiesModel` derives its editable fields from whatever own
 * string properties the root has, so naming the grammar union here would buy no
 * type-safety for a type that erases.
 */
type OrderFlowTransferRoot = TransferElement;

/**
 * The page's second data-head participant: a properties form over whichever
 * document has the editor focus.
 *
 * **A wiring job, not a form.** The DOM is `PropertiesForm`'s and the
 * open/watch/write/reconcile policy is `OrderFlowPropertiesModel`'s, both shared
 * verbatim with the Theia widget and the VS Code webview. What a host adds is
 * how it reaches the data head and what decides the document — here, a session
 * off the page's existing connection, and editor focus.
 *
 * **Focus rather than the workspace selection, and the field data is what
 * decides it.** A `DomainModel` root has no top-level string property at all, so
 * a panel bound to the selection editor — which opens on a `.domain` — renders
 * empty and stays empty; the two roots that do have editable fields,
 * `ProcessModel` and `LayoutModel`, are exactly the two documents pinned beside
 * the diagram, which the selection editor refuses to load because showing one
 * document in two editors would split the cursor between them.
 */
export class PropertiesPanel {
   protected readonly form: PropertiesForm;
   protected readonly model: OrderFlowPropertiesModel<OrderFlowTransferRoot>;
   /** The document currently open, so a repeated focus is not reloaded. */
   protected openUri?: string;

   constructor(session: DataSession<OrderFlowTransferRoot>, events: DataEvents<OrderFlowTransferRoot>) {
      this.model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session, events);
      this.form = new PropertiesForm(
         requireElement('properties-body'),
         {
            setField: (name, value) => this.model.setField(name, value),
            reportError: (error, reported) => this.reportError(error, reported)
         },
         {
            // The form's heading is the document's, and here it sits inside a
            // panel the page has already headed `Properties` with an `h2`.
            headingLevel: 'h3',
            renderMessage: this.renderMessage
         }
      );
      this.model.onDidChange(() => this.render());
   }

   /** The document this panel is showing, for a host that saves what is in front of the reader. */
   get documentUri(): string | undefined {
      return this.openUri;
   }

   /**
    * Open `uri`, or clear the panel when there is none.
    *
    * Re-opening the document already shown is a no-op rather than a reload,
    * because every focus change republishes — clicking between the two pinned
    * editors and back would otherwise close and reopen the document, dropping
    * the server-side watch each time.
    */
   showDocument(uri: string | undefined): void {
      if (uri === this.openUri) {
         return;
      }
      this.openUri = uri;
      if (!uri) {
         this.form.setTitle(undefined);
         void this.model.close().catch((error: unknown) => {
            this.reportError(error, resolve(PROPERTIES_CLOSE_FAILED, { detail: describeFailure(error, this.renderMessage) }));
         });
         return;
      }
      this.form.setTitle(uri.substring(uri.lastIndexOf('/') + 1));
      this.form.setLoading(true);
      this.form.report(PROPERTIES_LOADING);
      this.model
         .open(uri)
         .then(() => {
            this.form.setLoading(false);
            // Rendered explicitly: the model fires its change synchronously
            // inside `open`, while `loading` is still true, so a root that
            // genuinely has NO fields would have its suppressed empty render be
            // the only one and the panel would keep the previous document's
            // inputs.
            this.render();
            this.form.report('');
         })
         .catch((error: unknown) => {
            this.form.setLoading(false);
            const detail = describeFailure(error, this.renderMessage);
            this.reportError(error, resolve(PROPERTIES_OPEN_FAILED, { uri, detail }));
            this.form.report(detail, 'error');
         });
   }

   /** Renders the form's sentences and a failure's own through the page's catalogue. */
   protected readonly renderMessage = (message: ResolvedMessage): string => renderFrameworkMessage(message, pageTranslations());

   protected render(): void {
      this.form.setFields(this.model.fields);
      this.form.setDiagnostics(this.model.diagnostics);
   }

   /**
    * The page has one status line and no notification surface, so failures go to
    * the console — the same sink the data port reports through, so a failure the
    * form raises and one the transport raises arrive by one path.
    *
    * No translation map: this host ships no catalogue for the framework's own
    * codes, and omitting the argument is how a host without one takes the
    * English.
    */
   protected reportError(error: unknown, reported: ResolvedMessage): void {
      console.error(`[properties] ${renderFrameworkMessage(reported)}`, error);
   }
}
