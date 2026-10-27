/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type WorkingCopyEditOutcome, type TransferElement, WorkingCopy } from '@hydranium/protocol';

/** One editable top-level property of the open document's root. */
export interface PropertyField {
   /** Transfer-model property name, which is also the wire name. */
   readonly name: string;
   /** Current value, with the edits the server has not confirmed applied. */
   readonly value: string;
}

/** What {@link OrderFlowPropertiesModel.setField} did. A host renders each status differently. */
export type SetFieldOutcome = WorkingCopyEditOutcome;

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
export class OrderFlowPropertiesModel<TTransfer extends TransferElement> extends WorkingCopy<TTransfer> {
   /**
    * The editable top-level fields, in the root's own property order, with the
    * edits not yet confirmed applied.
    *
    * Empty before {@link open}, and empty for a root that has no string-valued
    * top-level property, which is a legitimate state rather than an error.
    */
   get fields(): readonly PropertyField[] {
      const root = this.root;
      return root ? this.fieldsOf(root) : [];
   }

   /** The editable top-level fields of `root`, in its own property order. */
   protected fieldsOf(root: TTransfer): PropertyField[] {
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
    * Write `value` to the field called `name`.
    *
    * The whole root goes back, because `TransferUpdateDocumentArgs.model` IS the
    * document root — there is no path- or op-scoped variant, since the encoder
    * is AST→transfer only and the parser is the decoder. So a field edit is
    * read-modify-write, and `baseVersion` plus patch replay is what keeps it
    * from clobbering a concurrent writer rather than finer granularity.
    *
    * **This is destructive to formatting, and an adopter has to tell its users
    * so.** The server's only route from a transfer model back to text is the
    * serializer, which emits the whole document — so one field edit re-lays-out
    * every line, and hand-wrapping goes. Comments are carried across separately,
    * taken off the document being overwritten rather than travelling in the
    * payload, so the absence of a trivia channel on the transfer model does not
    * decide their fate; layout has no such counterpart.
    */
   async setField(name: string, value: string): Promise<SetFieldOutcome> {
      this.assertLive();
      const root = this.root;
      if (!root) {
         throw new Error('No document is open');
      }
      const current = this.fieldsOf(root).find(field => field.name === name);
      if (!current) {
         throw new Error(`'${name}' is not an editable field of ${root.$type}`);
      }
      if (current.value === value) {
         return { status: 'unchanged' };
      }
      return this.edit(edited => withField(edited, name, value));
   }
}
