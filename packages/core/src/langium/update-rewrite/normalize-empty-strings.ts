/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type UpdateRewriteContribution, type UpdateRewriteRegistry } from './update-rewrite-contribution.js';

/**
 * Ready-made {@link UpdateRewriteContribution} that registers one rewrite —
 * the `'' → unset` normalisation — and exposes the transform itself as the
 * overridable {@link normalize} hook.
 *
 * **Why this exists.** An HTML form control that the user clears emits `''`,
 * never `undefined` / absent — but a structured diff treats `''` and absent as
 * different. Without normalisation, the same "clear the field" gesture produces
 * two different persisted outcomes depending on the field's grammar default (a
 * literal `field: ''` local override vs re-inheriting). Collapsing `'' → unset`
 * makes "clear" uniformly mean "remove my local value", the only intent the
 * form can express.
 *
 * **Opt-in.** The framework never binds this by default: dropping `''` encodes a
 * grammar-specific "`''` is never meaningful" assumption, so it would silently
 * lose data for a grammar where `''` is meaningful. Bind it under a named
 * sub-key of your module's `updateRewrite.rewrites` group when your form
 * transport emits `''`.
 *
 * **Adapt** by subclassing and overriding {@link normalize} — e.g. to preserve
 * grammar-meaningful empties for specific keys — without touching the
 * registration glue.
 */
export class NormalizeEmptyStringsContribution implements UpdateRewriteContribution {
   registerUpdateRewrites(registry: UpdateRewriteRegistry): void {
      registry.register({
         id: 'normalize-empty-strings',
         // Low priority so it runs before any diff-based rewrite — a
         // reconciliation pass should see cleared fields already read as unset.
         priority: -100,
         rewrite: model => this.normalize(model)
      });
   }

   /**
    * Collapse empty-string properties to "unset" (drop the key) throughout the
    * transfer-model graph. Override to adapt the rule (the override applies at
    * every depth, since the walk recurses through this method).
    *
    * Scope of the walk:
    *  - Recurses object properties and into object elements of arrays.
    *  - Leaves **primitive array elements** untouched — e.g. reference-id
    *    strings must not have an accidental `''` turned into a hole in the array.
    *  - Leaves `$`-prefixed (Langium internals like `$type`) and `_`-prefixed
    *    (derived metadata) keys verbatim — downstream rewrites read them.
    *  - Leaves Langium `Reference` objects (`{ $refText }`) verbatim.
    *
    * Pure — returns a new object graph, does not mutate its input.
    */
   protected normalize<T>(value: T): T {
      if (value === null || typeof value !== 'object') {
         return value;
      }
      if (Array.isArray(value)) {
         // Recurse into object elements only; primitive elements (reference strings) pass through.
         return value.map(item => (item !== null && typeof item === 'object' ? this.normalize(item) : item)) as unknown as T;
      }
      const record = value as Record<string, unknown>;
      if ('$refText' in record) {
         return value;
      }
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) {
         if (key.startsWith('$') || key.startsWith('_')) {
            result[key] = entry;
            continue;
         }
         if (entry === '') {
            continue; // empty-string property → treat as unset (drop the key, equivalent to absent)
         }
         result[key] = this.normalize(entry);
      }
      return result as T;
   }
}
