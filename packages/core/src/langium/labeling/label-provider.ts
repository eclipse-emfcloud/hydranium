/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type AstNode } from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumLanguageServices } from '../language-module.js';
import { type NameProvider } from '../naming/name-provider.js';

/** Construction-time options for {@link DefaultLabelProvider}. */
export interface LabelProviderOptions extends LogNameOptions {
   /**
    * Property names checked, in order, when reading a node's own label.
    * Default `['name']` — matches the common case where the grammar's
    * `name` property is the human-readable label. Adopters whose grammar
    * carries the display string on a different property override here;
    * the property is deliberately separate from the
    * {@link NameProvider}'s `nameProperties` (identifier axis).
    */
   readonly labelProperties?: readonly string[];
}

/**
 * Labeling service — **the UI axis**, sibling to {@link NameProvider}.
 *
 * `NameProvider` answers "what identifier does the language engine index /
 * resolve this node by" (read from `nameProperties`); `LabelProvider` answers
 * "what string do we show a human for this node" (read from
 * `labelProperties`). For the common adopter the two coincide (`['name']`),
 * but they are genuinely distinct concerns — an adopter might resolve by an
 * `id` field yet label by `name` — so the framework keeps them on separate
 * services. Folding labeling back into `NameProvider` would mean a method that
 * bypasses `nameProperties`, which is the thing that makes the identifier axis
 * predictable.
 *
 * Depends one-way on {@link NameProvider}: {@link getLabelOrName} falls back
 * to the identifier when no label exists, which is the only method that
 * reaches across the two axes.
 *
 * **No total method on purpose.** "Produce a non-empty string come what may"
 * is a per-call-site presentation decision, so both methods may return
 * `undefined` and every caller owns its own tail `??`.
 */
export interface LabelProvider {
   /**
    * The node's own label from {@link LabelProviderOptions.labelProperties},
    * or `undefined` when none is present (or for `undefined` input). The
    * primitive — callers compose their own fallback.
    */
   getLabel(node?: AstNode): string | undefined;

   /** Predicate form of {@link getLabel}. */
   hasLabel(node?: AstNode): boolean;

   /**
    * The label, falling back to the identifier when no label exists:
    * `getLabel(node) ?? NameProvider.getOwnName(node)`. May still be
    * `undefined` (a fully anonymous node) — the caller supplies the final
    * placeholder. The one method that bridges the label and name axes, so a UI
    * site need inject only this service.
    */
   getLabelOrName(node?: AstNode): string | undefined;
}

/**
 * Default {@link LabelProvider}. Reads a node's label from the configured
 * {@link LabelProviderOptions.labelProperties} (default `['name']`).
 */
export class DefaultLabelProvider implements LabelProvider {
   protected readonly labelProperties: readonly string[];
   protected readonly nameProvider: NameProvider;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: LabelProviderOptions = {}
   ) {
      this.labelProperties = options.labelProperties ?? ['name'];
      this.nameProvider = services.references.NameProvider;
      this.tracer = services.shared.Tracer.for(options.logName ?? 'LabelProvider').trace('instantiated');
   }

   getLabel(node?: AstNode): string | undefined {
      if (!node) {
         return undefined;
      }
      const indexed = node as unknown as Record<string, unknown>;
      for (const property of this.labelProperties) {
         const value = indexed[property];
         if (typeof value === 'string') {
            return value;
         }
      }
      return undefined;
   }

   hasLabel(node?: AstNode): boolean {
      return this.getLabel(node) !== undefined;
   }

   getLabelOrName(node?: AstNode): string | undefined {
      return this.getLabel(node) ?? this.nameProvider.getOwnName(node);
   }
}
