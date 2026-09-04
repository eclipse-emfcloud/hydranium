/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `writes Order.status = PAID` — the cross-grammar reference chain this
 * example exists for. Three references, each scoped by the previous one:
 * entity from the global index, field from THAT entity, enum literal from the
 * enumeration that field's type resolves to.
 *
 * The positive cases prove the chain resolves across a grammar boundary. The
 * negative cases are the ones that matter: with Langium's default scope the
 * dependent references would see every `Field` and every `EnumLiteral` in the
 * workspace, so `Order.total = PAID` would link and a typo'd field name would
 * resolve to a same-named field on an unrelated entity.
 */

import { describe, expect, it } from 'vitest';
import type { ReferenceInfo } from '@hydranium/langium';
import { type ProcessModel, type Read, type Task, type Write, isRead, isTask, isWrite } from '../src/language-server/ast.js';
import { documentFor, loadFixture, makeWorkspaceHarness, type OrderFlowHarness } from './order-flow-harness.js';

function taskNamed(model: ProcessModel, name: string): Task {
   const found = model.nodes.find(node => isTask(node) && node.name === name);
   if (!found || !isTask(found)) {
      throw new Error(`No task '${name}' in process ${model.name}`);
   }
   return found;
}

function writeOf(task: Task): Write {
   const found = task.effects.find(isWrite);
   if (!found) {
      throw new Error(`Task ${task.name} carries no write effect`);
   }
   return found;
}

function readOf(task: Task): Read {
   const found = task.effects.find(isRead);
   if (!found) {
      throw new Error(`Task ${task.name} carries no read effect`);
   }
   return found;
}

/** Candidate names the `.process` scope provider offers for one reference of an effect. */
function candidates(harness: OrderFlowHarness, effect: Write | Read, property: 'entity' | 'field' | 'literal'): string[] {
   const reference = property === 'literal' ? (effect as Write).literal : effect[property];
   const context: ReferenceInfo = { container: effect, property, reference };
   return harness.process.references.ScopeProvider.getScope(context)
      .getAllElements()
      .map(description => description.name)
      .toArray();
}

describe('order-flow effect chain — the nested cross-grammar reference', () => {
   it('resolves entity, field and enum literal of `writes Order.status = PAID`', async () => {
      const harness = await makeWorkspaceHarness();
      const write = writeOf(taskNamed(documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value, 'Pay'));

      expect(write.entity.ref?.name).toBe('Order');
      expect(write.field.ref?.name).toBe('status');
      expect(write.literal.ref?.name).toBe('PAID');
      // The literal's container is the enumeration the field is typed with —
      // the second hop, through `Field.type.declared`.
      expect(write.literal.ref?.$container.name).toBe('OrderStatus');
   });

   it('resolves the process subject and a read effect across the grammar boundary', async () => {
      const harness = await makeWorkspaceHarness();
      const model = documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value;

      expect(model.subject.ref?.name).toBe('Order');
      expect(readOf(taskNamed(model, 'Pick')).field.ref?.name).toBe('id');
   });

   it('resolves the same domain entity from a second process file', async () => {
      const harness = await makeWorkspaceHarness();
      const model = documentFor<ProcessModel>(harness, 'orders/returns.process').parseResult.value;

      expect(model.subject.ref?.name).toBe('Order');
      expect(writeOf(taskNamed(model, 'Restock')).literal.ref?.name).toBe('NEW');
   });

   it('offers only the fields of the resolved entity for the field reference', async () => {
      const harness = await makeWorkspaceHarness();
      const write = writeOf(taskNamed(documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value, 'Pay'));

      expect(candidates(harness, write, 'field').sort()).toEqual(['id', 'lines', 'shipTo', 'status', 'total']);
      // LineItem's fields are NOT offered, which is the whole point — the
      // unfiltered global scope would include `sku`, `quantity` and `price`.
      expect(candidates(harness, write, 'field')).not.toContain('sku');
   });

   it('offers only the literals of the enumeration the field is typed with', async () => {
      const harness = await makeWorkspaceHarness();
      const write = writeOf(taskNamed(documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value, 'Pay'));

      expect(candidates(harness, write, 'literal').sort()).toEqual(['CANCELLED', 'NEW', 'PAID', 'SHIPPED']);
   });

   it('offers nothing for a literal on a non-enum field, so the assignment fails to link', async () => {
      const harness = await makeWorkspaceHarness();
      const model = (await loadFixture<ProcessModel>(harness, 'broken-effect.process')).parseResult.value;
      const write = writeOf(taskNamed(model, 'Overreach'));

      expect(write.field.ref?.name).toBe('total');
      expect(candidates(harness, write, 'literal')).toEqual([]);
      expect(write.literal.ref).toBeUndefined();
      expect(write.literal.$refText).toBe('PAID');
   });

   it('fails a field reference that names no field of the resolved entity', async () => {
      const harness = await makeWorkspaceHarness();
      const model = (await loadFixture<ProcessModel>(harness, 'broken-effect.process')).parseResult.value;
      const read = readOf(taskNamed(model, 'Ghost'));

      expect(read.entity.ref?.name).toBe('Order');
      expect(read.field.ref).toBeUndefined();
      expect(read.field.$refText).toBe('nosuchfield');
   });
});
