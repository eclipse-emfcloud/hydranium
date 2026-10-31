/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type DataEvents, type DataSession, resolve, type ResolvedMessage, type TransferElement } from '@hydranium/protocol';
import { OrderFlowPropertiesModel, type SetFieldOutcome } from '../data/order-flow-properties-model';
import { describeFailure, type PropertiesForm } from './properties-form';
import { PROPERTIES_LOADING, PROPERTIES_OPEN_FAILED } from './properties-messages';

/**
 * The documents a properties panel shows, one at a time, each through a model
 * of its own, so an edit can only land on the document it was made for.
 *
 * Showing another document closes the model before and disposes it, which
 * still writes its edits. A model of a document still closing opens only once
 * that close has settled, since the session holds one open per document and
 * the close would end the new open too. A model shown before stays counted in
 * {@link documentsWithWritesInFlight} until its writes answer.
 */
export class PropertiesDocuments<TTransfer extends TransferElement> {
   /** The model of the document shown. */
   protected model?: OrderFlowPropertiesModel<TTransfer>;
   /** The model whose load is under way. */
   protected loading?: OrderFlowPropertiesModel<TTransfer>;
   /** The model whose open failed, not loaded again when shown again unless `retryFailedOpen` is set. */
   protected openFailed?: OrderFlowPropertiesModel<TTransfer>;
   /** The close of each document shown before, while one is under way. */
   protected readonly closing = new Map<string, Promise<void>>();
   /**
    * The models shown before, until their writes have answered. A close gives
    * up waiting for them, and a save and an unload guard must not. The writes
    * a close makes go through these models, so they are counted too.
    */
   protected readonly retired = new Set<OrderFlowPropertiesModel<TTransfer>>();
   protected disposed = false;
   /**
    * Load a document whose open failed again when it is shown again, for a
    * host that shows a document only when asked to.
    */
   protected readonly retryFailedOpen: boolean = false;

   constructor(
      protected readonly session: DataSession<TTransfer>,
      protected readonly events: DataEvents<TTransfer>,
      protected readonly form: Pick<
         PropertiesForm,
         'switchDocument' | 'setLoading' | 'report' | 'setFields' | 'setDiagnostics' | 'setDirty'
      >,
      protected readonly handlers: {
         reportError(error: unknown, reported: ResolvedMessage): void;
         renderMessage(message: ResolvedMessage): string;
      }
   ) {}

   /** The model of the document shown, if any. */
   get current(): OrderFlowPropertiesModel<TTransfer> | undefined {
      return this.model;
   }

   /** The documents with a field edit not answered yet, a previous one included, for an unload guard. */
   get documentsWithWritesInFlight(): readonly string[] {
      const models = [...this.retired, ...(this.model ? [this.model] : [])];
      return [...new Set(models.filter(model => model.hasWritesInFlight).map(model => model.uri))];
   }

   /** Resolves to whether the field edits of the documents shown at the call, those made during the wait included, answered within each model's bound. */
   async whenWritesSettled(): Promise<boolean> {
      const models = [...this.retired, ...(this.model ? [this.model] : [])];
      const settled = await Promise.all(models.map(model => model.whenWritesSettled()));
      this.pruneRetired();
      return settled.every(Boolean);
   }

   /** Set a field of the document shown. Rejects when no document is shown. */
   setField(name: string, value: string): Promise<SetFieldOutcome> {
      if (!this.model) {
         return Promise.reject(new Error('No document is open'));
      }
      return this.model.setField(name, value);
   }

   /**
    * Show `uri`, or no document. Shown again, the document loads again only
    * when its model follows none and no load is under way, as after a
    * deletion or a restore that could not open it again. After a failed open
    * it does not, so a focus does not report the failure again, unless
    * `retryFailedOpen` is set.
    */
   show(uri: string | undefined): void {
      if (this.disposed) {
         return;
      }
      if (uri !== undefined && this.model?.uri === uri) {
         if (!this.model.snapshot && this.loading !== this.model && (this.retryFailedOpen || this.openFailed !== this.model)) {
            this.load(this.model);
         }
         return;
      }
      if (uri === undefined && !this.model) {
         return;
      }
      this.form.switchDocument(uri);
      this.retire();
      this.openFailed = undefined;
      // Cleared by the switch, so no line for a document without fields shows.
      if (uri === undefined) {
         return;
      }
      const model = new OrderFlowPropertiesModel<TTransfer>(this.session, this.events, uri);
      this.model = model;
      // A copy shown before is disposed, so it announces nothing more.
      model.onDidChange(() => this.render());
      model.onDidChangeDirty(() => this.form.setDirty(model.dirty));
      this.load(model);
   }

   /**
    * Close the document shown, and resolve once every close has settled. A
    * close that fails is not reported. Nothing is shown after.
    */
   async dispose(): Promise<void> {
      this.disposed = true;
      const model = this.model;
      this.model = undefined;
      const closed = model?.close().catch(() => undefined);
      model?.dispose();
      await closed;
      await Promise.all(this.closing.values());
   }

   protected retire(): void {
      const previous = this.model;
      this.model = undefined;
      this.pruneRetired();
      if (!previous) {
         return;
      }
      this.retired.add(previous);
      // Its edits are still written once disposed. A failed close is not
      // reported, since the panel shows another document by then.
      const closed = previous.close().catch(() => undefined);
      previous.dispose();
      const closing = Promise.all([this.closing.get(previous.uri), closed]).then(() => undefined);
      this.closing.set(previous.uri, closing);
      void closing.then(() => {
         if (this.closing.get(previous.uri) === closing) {
            this.closing.delete(previous.uri);
         }
         this.pruneRetired();
      });
   }

   protected load(model: OrderFlowPropertiesModel<TTransfer>): void {
      this.loading = model;
      this.form.setLoading(true);
      this.form.report(PROPERTIES_LOADING);
      Promise.resolve(this.closing.get(model.uri))
         .then(() => (this.model === model ? model.open() : undefined))
         .then(() => {
            if (this.model !== model) {
               return;
            }
            this.openFailed = undefined;
            this.form.setLoading(false);
            // Rendered explicitly: the model fires its change inside `open`,
            // while the form still loads and skips an empty render, so a root
            // with no fields would leave the inputs of the one before.
            this.render();
            this.form.report('');
         })
         .catch((error: unknown) => {
            if (this.model !== model) {
               return;
            }
            this.openFailed = model;
            this.form.setLoading(false);
            const detail = describeFailure(error, this.handlers.renderMessage);
            this.handlers.reportError(error, resolve(PROPERTIES_OPEN_FAILED, { uri: model.uri, detail }));
            this.form.report(detail, 'error');
         })
         .finally(() => {
            if (this.loading === model) {
               this.loading = undefined;
            }
         });
   }

   protected pruneRetired(): void {
      this.retired.forEach(model => {
         if (!model.hasWritesInFlight) {
            this.retired.delete(model);
         }
      });
   }

   protected render(): void {
      this.form.setFields(this.model?.fields ?? []);
      this.form.setDiagnostics(this.model?.diagnostics ?? []);
   }
}
