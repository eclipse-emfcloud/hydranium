/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type DataEvents,
   type DataSession,
   type LoadedTransferDocument,
   type TransferDiagnostic,
   type TransferElement,
   TransferDocument,
   isConflictError,
   reconcileByPatchReplay
} from '@hydranium/protocol';
import { Emitter, type Event } from 'vscode-jsonrpc';

/** One editable top-level property of the open document's root. */
export interface PropertyField {
   /** Transfer-model property name, which is also the wire name. */
   readonly name: string;
   /** Current value as the server last reported it. */
   readonly value: string;
}

/**
 * What {@link OrderFlowPropertiesModel.setField} did. A host renders each of
 * these differently, which is why the write returns a status rather than
 * `void` or a bare boolean.
 */
export type SetFieldOutcome =
   /** The write landed against an unchanged document. */
   | { readonly status: 'applied' }
   /** The write raced a foreign edit to a DIFFERENT field; both intents survive. */
   | { readonly status: 'merged' }
   /** The write raced a foreign edit to the SAME field; the write was dropped and the panel now shows the server's value. */
   | { readonly status: 'conflict' }
   /** The value was already what was asked for; nothing was sent. */
   | { readonly status: 'unchanged' }
   /** The conflict could not be reconciled because the document could not be refetched. */
   | { readonly status: 'unavailable' };

/**
 * Copy `root` with one string property replaced.
 *
 * The cast is contained here deliberately. A shallow clone with one own,
 * string-valued, non-internal property replaced is still the same transfer
 * type — {@link OrderFlowPropertiesModel.fields} only ever names properties of
 * exactly that kind, so no member of the root union changes shape. Doing it
 * inline at the call site would spread the same assumption across the write
 * path instead of stating it once.
 */
function withField<TTransfer extends TransferElement>(root: TTransfer, name: string, value: string): TTransfer {
   const copy: Record<string, unknown> = { ...(root as unknown as Record<string, unknown>) };
   copy[name] = value;
   return copy as unknown as TTransfer;
}

/**
 * A document-scoped properties panel, without the panel.
 *
 * Everything a properties view does that is not drawing: load the document,
 * present its editable top-level fields, write one back, survive a concurrent
 * writer, and follow the document as it changes underneath. A host renders
 * {@link fields} and calls {@link setField}; it supplies no policy of its own.
 *
 * **Document-scoped, not selection-scoped, and that is a decision rather than a
 * simplification.** Nothing in the framework bridges GLSP selection to a host
 * widget, so selection is shell-owned glue; and a transfer element carries only
 * `$type` — no id, and `name` on just some types — so the only cross-rebuild
 * address available is a positional path, which a foreign insert invalidates.
 * Scoping to the document drops both problems while still exercising the whole
 * open → watch → update → close path.
 *
 * **Fields are derived, not declared.** Every own property of the root whose
 * value is a string counts, minus the `$`-prefixed internals and the
 * `_`-prefixed derived ones. So this file names no grammar and no property, and
 * a grammar change is picked up without editing it. The cost is that a
 * cross-reference — `subject` on a process, whose transfer form is its `$refText`
 * string — is presented like any other string, and editing it to an unresolvable
 * name produces a diagnostic rather than a rejection. That is the honest
 * behaviour of the wire shape and not something to paper over here.
 */
export class OrderFlowPropertiesModel<TTransfer extends TransferElement> {
   protected readonly changeEmitter = new Emitter<void>();
   /** Fires whenever {@link fields} or {@link diagnostics} may have changed. */
   readonly onDidChange: Event<void> = this.changeEmitter.event;

   /** The current server snapshot — the baseline every write is authored against. */
   protected snapshot?: TransferDocument<TTransfer>;
   protected readonly subscription: { dispose(): void };
   protected disposed = false;

   constructor(
      protected readonly session: DataSession<TTransfer>,
      events: DataEvents<TTransfer>
   ) {
      this.subscription = events.onDidUpdateDocument(event => this.handleDocumentUpdated(event));
   }

   /** URI of the open document, or `undefined` before {@link open}. */
   get uri(): string | undefined {
      return this.snapshot?.uri;
   }

   /** The open document's version — what a write is gated against. */
   get version(): number | undefined {
      return this.snapshot?.version;
   }

   /**
    * The editable top-level fields, in the root's own property order.
    *
    * Empty before {@link open}, and empty for a root that has no string-valued
    * top-level property, which is a legitimate state rather than an error.
    */
   get fields(): readonly PropertyField[] {
      const root = this.snapshot?.root;
      if (!root) {
         return [];
      }
      const fields: PropertyField[] = [];
      for (const [name, value] of Object.entries(root)) {
         if (name.startsWith('$') || name.startsWith('_')) {
            continue;
         }
         if (typeof value === 'string') {
            fields.push({ name, value });
         }
      }
      return fields;
   }

   /**
    * Diagnostics as of the last snapshot.
    *
    * Trustworthy straight after {@link open}, which settles at validation for
    * exactly that reason. Still NOT trustworthy straight after a write: an
    * update is answered at the integrity landmark, so validity for the edited
    * state arrives on the next `onDidUpdateDocument` — which is one reason this
    * model follows the document rather than reading it once.
    */
   get diagnostics(): readonly TransferDiagnostic[] {
      return this.snapshot?.diagnostics ?? [];
   }

   /**
    * Load `uri` and start following it. Replaces whatever was open, closing it
    * first so the server's watch and client registration do not leak.
    *
    * **Two reads, because one cannot answer both questions.**
    * `openDocument` registers the client and the watch, but settles at the
    * integrity landmark, where the diagnostics array is empty *by phase
    * contract* rather than because the document is valid. Following the open
    * with `includeDiagnostics` settles at validation and is what makes a
    * document that is merely SELECTED report its problems. Without it the panel
    * shows diagnostics only for documents the user has edited — an edit takes
    * the update path, which is answered post-validation — so a file whose
    * references were broken from elsewhere reads as clean, which is worse than
    * showing nothing at all.
    *
    * The cost, stated rather than hidden: one extra round trip per selection,
    * and the open now waits for validation instead of the earlier landmark.
    * That is the price of the panel being trustworthy about validity, and it is
    * paid per selection rather than per keystroke.
    *
    * The change fires once, after both reads, so a selection renders one state
    * rather than flashing the undiagnosed one first.
    */
   async open(uri: string): Promise<void> {
      this.assertLive();
      if (this.snapshot && this.snapshot.uri !== uri) {
         await this.close();
      }
      this.snapshot = await this.session.openDocument(uri);
      const server = await this.session.connected();
      this.snapshot = await server.getModelDocument({ uri, includeDiagnostics: true });
      this.changeEmitter.fire(undefined);
   }

   /**
    * Write `value` to the field called `name`.
    *
    * The whole root goes back, because `TransferUpdateArgs.model` IS the
    * document root — there is no path- or op-scoped variant, since the encoder
    * is AST→transfer only and the parser is the decoder. So a field edit is
    * read-modify-write, and `baseVersion` plus patch replay is what keeps it
    * from clobbering a concurrent writer rather than finer granularity.
    *
    * **This is destructive to comments and formatting, and an adopter has to
    * tell its users so.** The server's only route from a transfer model back to
    * text is the serializer, which emits the whole document — so one field edit
    * rewrites the file, dropping every comment and re-laying-out every line. The
    * transfer model has no trivia channel, so there is nothing for the encode
    * side to round-trip; it is a property of the layer boundary rather than
    * something this panel could avoid.
    */
   async setField(name: string, value: string): Promise<SetFieldOutcome> {
      this.assertLive();
      const open = this.snapshot;
      if (!open) {
         throw new Error('No document is open');
      }
      // An open snapshot is not enough: `root` is absent when the server has no
      // such document, and there is nothing to edit against then.
      const baseline = TransferDocument.assertLoaded(open);
      const current = this.fields.find(field => field.name === name);
      if (!current) {
         throw new Error(`'${name}' is not an editable field of ${baseline.root.$type}`);
      }
      if (current.value === value) {
         return { status: 'unchanged' };
      }

      const attempted = withField(baseline.root, name, value);
      const server = await this.session.connected();
      try {
         this.adopt(
            await server.updateModelDocument({
               uri: baseline.uri,
               clientId: this.session.clientId,
               model: attempted,
               baseVersion: baseline.version
            })
         );
         return { status: 'applied' };
      } catch (error: unknown) {
         // The reconstructed error is a plain `ResponseError`, so the subclass
         // does not survive the round trip and the free-function guard is the
         // only correct check.
         if (!isConflictError(error)) {
            throw error;
         }
         return this.reconcile(baseline, attempted);
      }
   }

   /** Close the open document. The server unwatches implicitly. Safe when nothing is open. */
   async close(): Promise<void> {
      const open = this.snapshot;
      if (!open) {
         return;
      }
      this.snapshot = undefined;
      await this.session.closeDocument(open.uri);
      this.changeEmitter.fire(undefined);
   }

   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      this.subscription.dispose();
      this.changeEmitter.dispose();
      this.snapshot = undefined;
   }

   /**
    * Resolve a `ConflictError` by replaying the user's intent on top of the
    * server's current root.
    *
    * The refetched document is captured rather than only its root, because a
    * successful replay has to be written back against the version it was
    * merged onto — retrying without a `baseVersion` would silently reopen the
    * hole the gate exists to close.
    */
   protected async reconcile(baseline: LoadedTransferDocument<TTransfer>, attempted: TTransfer): Promise<SetFieldOutcome> {
      const server = await this.session.connected();
      let fresh: TransferDocument<TTransfer> | undefined;
      const outcome = await reconcileByPatchReplay(baseline.root, attempted, async () => {
         fresh = await server.getModelDocument({ uri: baseline.uri });
         // Deleted while the conflict was being resolved. Replaying onto an
         // invented empty root would write the file back.
         return TransferDocument.assertLoaded(fresh).root;
      });

      switch (outcome.status) {
         case 'merged':
            this.adopt(
               await server.updateModelDocument({
                  uri: baseline.uri,
                  clientId: this.session.clientId,
                  model: outcome.merged,
                  baseVersion: fresh?.version
               })
            );
            return { status: 'merged' };
         case 'conflict':
            // The user's edit is dropped on a same-field collision rather than
            // clobbering the other writer. Showing the server's value is what
            // makes that visible instead of leaving a stale field on screen.
            if (fresh) {
               this.adopt(fresh);
            }
            return { status: 'conflict' };
         case 'no-op':
            return { status: 'unchanged' };
         case 'unavailable':
            return { status: 'unavailable' };
      }
   }

   /** Follow a server push for the open document. */
   protected handleDocumentUpdated(event: { document: TransferDocument<TTransfer>; sourceClientId: string; reason: string }): void {
      if (this.disposed || !this.snapshot || event.document.uri !== this.snapshot.uri) {
         return;
      }
      if (event.reason === 'deleted') {
         this.snapshot = undefined;
         this.changeEmitter.fire(undefined);
         return;
      }
      // Own echo: the write path already adopted the authoritative response, so
      // re-adopting would fire a second change for a state the host has already
      // rendered. That redundant render is the classic "the field resets while
      // I am typing" bug in a properties view, which is what makes the filter
      // worth having even though the CONTENT would be equivalent — a single
      // ordered connection delivers echoes in send order, so a stale one cannot
      // overtake a newer snapshot.
      if (this.session.isOwnEcho(event.sourceClientId)) {
         return;
      }
      this.adopt(event.document);
   }

   /** Take `document` as the new baseline and tell listeners. */
   protected adopt(document: TransferDocument<TTransfer>): void {
      this.snapshot = document;
      this.changeEmitter.fire(undefined);
   }

   protected assertLive(): void {
      if (this.disposed) {
         throw new Error('OrderFlowPropertiesModel is disposed');
      }
   }
}
