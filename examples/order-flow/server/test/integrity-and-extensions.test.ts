/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The two build-pipeline tiers this example wires: integrity rules, and AST
 * extensions with a cross-grammar computed property.
 *
 * Both are asserted through a real build rather than by constructing the rule
 * or the contribution directly — the framework dispatches integrity rules by
 * `nodeType` at a build phase, and populates computed properties from a phase
 * listener, so calling the classes by hand tests the class and not the wiring.
 */

import { describe, expect, it } from 'vitest';
import { type DomainModel, type ProcessModel, type Task, isTask } from '../src/language-server/ast.js';
import { documentFor, loadFixture, makeWorkspaceHarness, type OrderFlowHarness } from './order-flow-harness.js';

function taskNamed(model: ProcessModel, name: string): Task {
   const found = model.nodes.find(node => isTask(node) && node.name === name);
   if (!found || !isTask(found)) {
      throw new Error(`No task '${name}' in ${model.name}`);
   }
   return found;
}

async function fulfillment(harness: OrderFlowHarness): Promise<ProcessModel> {
   return documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value;
}

describe('order-flow integrity rules — bound, and running in the build', () => {
   it('leaves a well-formed workspace untouched', async () => {
      const harness = await makeWorkspaceHarness();
      const orders = documentFor<DomainModel>(harness, 'orders/orders.domain').parseResult.value;

      // No `__1` suffixes anywhere: the rules ran and found nothing to repair.
      expect(orders.declarations.map(declaration => declaration.name)).toEqual(['Order', 'OrderStatus', 'LineItem']);
      expect((await fulfillment(harness)).nodes.map(node => node.name)).toEqual(['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel']);
   });

   it('deduplicates repeated declaration names in a .domain document', async () => {
      const harness = await makeWorkspaceHarness();
      const model = (await loadFixture<DomainModel>(harness, 'duplicate-names.domain')).parseResult.value;

      // The rule repairs the tree rather than reporting, so the second
      // `Money` is renamed and both remain independently addressable.
      expect(model.declarations.map(declaration => declaration.name)).toEqual(['Money', 'Money__1', 'Order']);
   });

   it('deduplicates repeated flow-node names in a .process document', async () => {
      const harness = await makeWorkspaceHarness();
      const model = (await loadFixture<ProcessModel>(harness, 'duplicate-nodes.process')).parseResult.value;

      // Tasks and gateways share one name space, since a transition targets
      // `FlowNode` — so the collision is across both kinds, not within one.
      expect(model.nodes.map(node => node.name)).toEqual(['Pay', 'Pay__1', 'Pay__2']);
   });
});

describe('order-flow AST extensions — a cross-grammar computed property', () => {
   it('populates _writtenFields with the .domain fields a .process task writes', async () => {
      const harness = await makeWorkspaceHarness();
      const pay = taskNamed(await fulfillment(harness), 'Pay');

      // The property lives on a `.process` node and holds `.domain` nodes,
      // resolved through the shared index — not expressible with one grammar.
      expect(pay._writtenFields?.map(field => field.name)).toEqual(['status']);
      expect(pay._writtenFields?.[0]?.$container.name).toBe('Order');
   });

   it('keeps the referenced fields non-enumerable, so they are not task children', async () => {
      const harness = await makeWorkspaceHarness();
      const pay = taskNamed(await fulfillment(harness), 'Pay');

      // A second containment parent would corrupt every containment walk —
      // serialization, the transfer encoder, the AST-node locator.
      expect(Object.keys(pay)).not.toContain('_writtenFields');
      expect(pay._writtenFields).toBeDefined();
   });

   it('excludes read effects and deduplicates repeated writes', async () => {
      const harness = await makeWorkspaceHarness();
      const model = await fulfillment(harness);

      // `Pick` only reads, so it writes nothing.
      expect(taskNamed(model, 'Pick')._writtenFields).toEqual([]);
   });

   it('renders an effect summary that survives an unresolved chain', async () => {
      const harness = await makeWorkspaceHarness();
      const model = await fulfillment(harness);

      expect(taskNamed(model, 'Pay')._effectSummary).toBe('writes status=PAID (OrderStatus)');
      expect(taskNamed(model, 'Pick')._effectSummary).toBe('reads id');

      // On the broken fixture the field resolves but the literal does not, so
      // the summary falls back to the reference text rather than going blank.
      const broken = (await loadFixture<ProcessModel>(harness, 'broken-effect.process')).parseResult.value;
      expect(taskNamed(broken, 'Overreach')._effectSummary).toBe('writes total=PAID');
      expect(taskNamed(broken, 'Ghost')._effectSummary).toBe('reads nosuchfield');
   });
});
