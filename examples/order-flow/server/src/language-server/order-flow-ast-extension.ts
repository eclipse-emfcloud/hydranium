/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstExtensionContribution, type AstExtensionRegistry, setHiddenProperty } from '@hydranium/core';
import type { Mutable } from '@hydranium/protocol';
import { DocumentState } from '@hydranium/langium';
import { type Field, type Task, isEnumeration, isTask, isWrite } from './ast.js';

/**
 * Order-flow AST enrichment. Two registrations, both on `.process` nodes, and
 * both computed at `ComputedScopes` because that is the first phase at which
 * the effect chain's references resolve.
 *
 * `_writtenFields` is the interesting one and the reason this file exists: it
 * is a **cross-grammar** computed property. The value is a list of `.domain`
 * `Field` nodes, derived by walking a `.process` task's effects through
 * `Write.field.ref` — so the property lives on one grammar's node and holds
 * another grammar's nodes, resolved through the shared index. Nothing in a
 * single-grammar example can exercise that.
 *
 * Stored non-enumerable via `setHiddenProperty` so Langium's `streamContents`
 * does not yield the referenced fields as children of the task — they belong to
 * their entity, and a second parent would corrupt every containment walk
 * (serialization, the transfer encoder, the AST-node locator).
 *
 * `_effectSummary` is a plain enumerable string, the cheap counterpart: no
 * containment risk, recomputed each pass.
 *
 * Bound under `ast.extensions` in `order-flow-module.ts`; the framework's
 * `AstExtensionService` reads that group at construction and calls
 * `registerAstExtensions` here.
 */
export class OrderFlowComputedPropertiesContribution implements AstExtensionContribution {
   registerAstExtensions(registry: AstExtensionRegistry): void {
      registry.register({
         id: '_writtenFields',
         nodeFilter: isTask,
         state: DocumentState.ComputedScopes,
         compute: (node: Mutable<Task>) => {
            setHiddenProperty(node, '_writtenFields', collectWrittenFields(node));
         }
      });

      registry.register({
         id: '_effectSummary',
         nodeFilter: isTask,
         state: DocumentState.ComputedScopes,
         compute: (node: Mutable<Task>) => {
            node._effectSummary = summariseEffects(node);
         }
      });
   }
}

/**
 * The `.domain` fields a task writes, in effect order, deduplicated.
 *
 * Reads `write.field.ref` rather than the reference text, so an unresolved
 * effect contributes nothing instead of a dangling name — a broken model
 * yields a shorter list, never a wrong one.
 */
function collectWrittenFields(task: Task): Field[] {
   const result: Field[] = [];
   const seen = new Set<Field>();
   for (const effect of task.effects) {
      if (!isWrite(effect)) {
         continue;
      }
      const field = effect.field.ref;
      if (field && !seen.has(field)) {
         seen.add(field);
         result.push(field);
      }
   }
   return result;
}

/**
 * One-line human-readable rendering of a task's effects, e.g.
 * `writes status=PAID (OrderStatus)`. Uses the resolved enum literal where the
 * chain resolved and the raw reference text where it did not, so the summary stays
 * useful on a broken model — which is when someone is most likely reading it.
 */
function summariseEffects(task: Task): string {
   return task.effects
      .map(effect => {
         const fieldName = effect.field.ref?.name ?? effect.field.$refText;
         if (!isWrite(effect)) {
            return `reads ${fieldName}`;
         }
         const literal = effect.literal.ref;
         const enumeration = isEnumeration(literal?.$container) ? literal.$container.name : undefined;
         return `writes ${fieldName}=${literal?.name ?? effect.literal.$refText}${enumeration ? ` (${enumeration})` : ''}`;
      })
      .join(', ');
}
