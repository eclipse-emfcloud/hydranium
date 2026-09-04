/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumScopeProvider } from '@hydranium/core';
import { EMPTY_SCOPE, type ReferenceInfo, type Scope } from '@hydranium/langium';
import { type Field, type Read, type Write, isEnumeration, isRead, isWrite } from './ast.js';

/**
 * Scope provider for the `*.process` language, supplying the two
 * **dependent** references of `writes Order.status = PAID`.
 *
 * Only the first of the three references in that effect is an ordinary
 * global-index lookup. `field` and `literal` are not reachable from the
 * reference's container chain at all — their candidates live in a `.domain`
 * document that the process file merely points into — so Langium's default
 * `getScope` would return the global index filtered by type, i.e. every
 * `Field` in the workspace. That resolves the happy path by accident and
 * accepts `writes Order.status = SHIPPED` when `status` is not an
 * `OrderStatus`, which is precisely the mistake a language server exists to
 * catch.
 *
 * So each dependent reference gets exactly the candidates its predecessor
 * admits:
 *
 * - `field` — the fields of the entity `entity` resolved to.
 * - `literal` — the literals of the enumeration that field's type resolved
 *   to, which is a second hop (`Field.type.declared`) and yields an empty
 *   scope for a non-enum field, so `total = PAID` fails to link.
 *
 * Reading `.ref` here is what drives the chain: it triggers the linker for
 * the predecessor reference, so the candidate set for the next one is
 * computed against a resolved target. The `.process` → `.domain` dependency
 * is one-way by design, which is what keeps that from cycling.
 *
 * Everything else this provider sees — `subject`, the branch and transition
 * targets — falls through to the framework default and its project-visibility
 * filter.
 *
 * `createScopeForNodes` is the framework's re-keyed override of Langium's, so
 * entries come out under the bare segment the reference text carries. No
 * `outerScope` is passed, which is what makes `Order.nosuchfield` fail rather
 * than find a same-named field on some unrelated type.
 */
export class OrderFlowProcessScopeProvider extends HydraniumScopeProvider {
   override getScope(context: ReferenceInfo): Scope {
      const container = context.container;
      if (context.property === 'field' && (isWrite(container) || isRead(container))) {
         return this.createFieldScope(container);
      }
      if (context.property === 'literal' && isWrite(container)) {
         return this.createLiteralScope(container);
      }
      return super.getScope(context);
   }

   /** The fields of the entity the effect's `entity` reference resolved to. */
   protected createFieldScope(effect: Write | Read): Scope {
      const entity = effect.entity.ref;
      return entity ? this.createScopeForNodes(entity.fields) : EMPTY_SCOPE;
   }

   /**
    * The literals of the enumeration the effect's field is typed with.
    * Empty for a field typed with a primitive, an entity or a value type —
    * an enum literal is only assignable where an enum is declared.
    */
   protected createLiteralScope(write: Write): Scope {
      const field: Field | undefined = write.field.ref;
      const declared = field?.type.declared?.ref;
      return isEnumeration(declared) ? this.createScopeForNodes(declared.literals) : EMPTY_SCOPE;
   }
}
