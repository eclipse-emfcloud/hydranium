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
import { type DataEvents, type DataSession, renderFrameworkMessage, type ResolvedMessage, type TransferElement } from '@hydranium/protocol';
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
 * **A wiring job, not a form.** The DOM is `PropertiesForm`'s, the document
 * switch `PropertiesDocuments`' and the open/watch/write/reconcile policy
 * `WorkingCopy`'s, which `OrderFlowPropertiesModel` extends, all shared
 * verbatim with the Theia widget and the VS Code webview. What a host adds is
 * how it reaches the data head and what decides the document — here, a session
 * off the page's existing connection, and editor focus.
 *
 * **Focus rather than the workspace selection, and the field data is what
 * decides it.** A `DomainModel` root has no top-level string property at all, so
 * a panel bound to the selection editor — which opens on a `.domain` — renders
 * empty and stays empty; the only root that does have editable fields,
 * `ProcessModel`, is one of the two documents pinned beside the diagram, which
 * the selection editor refuses to load because showing one document in two
 * editors would split the cursor between them.
 */
export class PropertiesPanel {
   protected readonly form: PropertiesForm;
   protected readonly documents: PropertiesDocuments<OrderFlowTransferRoot>;

   constructor(session: DataSession<OrderFlowTransferRoot>, events: DataEvents<OrderFlowTransferRoot>) {
      this.form = new PropertiesForm(
         requireElement('properties-body'),
         {
            setField: (name, value) => this.documents.setField(name, value),
            reportError: (error, reported) => this.reportError(error, reported)
         },
         {
            // The form's heading is the document's, and here it sits inside a
            // panel the page has already headed `Properties` with an `h2`.
            headingLevel: 'h3',
            renderMessage: this.renderMessage
         }
      );
      this.documents = new PropertiesDocuments<OrderFlowTransferRoot>(session, events, this.form, {
         reportError: (error, reported) => this.reportError(error, reported),
         renderMessage: this.renderMessage
      });
   }

   /** The document this panel is showing, for a host that saves what is in front of the reader. */
   get documentUri(): string | undefined {
      return this.documents.current?.uri;
   }

   /** The documents with a field edit not answered yet, one shown before included, for the unload guard. */
   get documentsWithWritesInFlight(): readonly string[] {
      return this.documents.documentsWithWritesInFlight;
   }

   /** Resolves to whether the field edits of the documents shown at the call, those made during the wait included, answered within each model's bound. */
   whenWritesSettled(): Promise<boolean> {
      return this.documents.whenWritesSettled();
   }

   /**
    * Open `uri`, or clear the panel when there is none.
    *
    * Re-opening the document already shown is a no-op rather than a reload,
    * because every focus change republishes — clicking between the two pinned
    * editors and back would otherwise close and reopen the document, dropping
    * the server-side watch each time. A document whose copy follows none, as
    * after a deletion, loads again, but not after a failed open.
    */
   showDocument(uri: string | undefined): void {
      if (uri !== this.documents.current?.uri) {
         this.form.setTitle(uri && uri.substring(uri.lastIndexOf('/') + 1));
      }
      this.documents.show(uri);
   }

   /** Renders the form's sentences and a failure's own through the page's catalogue. */
   protected readonly renderMessage = (message: ResolvedMessage): string => renderFrameworkMessage(message, pageTranslations());

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
      // A lost edit of the document before comes with no error to log.
      console.error(`[properties] ${renderFrameworkMessage(reported)}`, ...(error === undefined ? [] : [error]));
   }
}
