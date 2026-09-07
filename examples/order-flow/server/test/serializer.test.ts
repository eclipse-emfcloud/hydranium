/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * One serializer per grammar, both reached through the per-URI
 * `ServiceRegistry` rather than a hard-coded pick — which is the part a
 * single-grammar example cannot test. Getting the routing wrong here writes
 * `.process` syntax into a `.domain` file and the failure only surfaces on the
 * next parse.
 *
 * Text equality is asserted for the shape (keyword order, modifier placement,
 * indentation) and a re-parse for the semantics, because equal text is the
 * stronger claim but a round-trip is the one that must hold.
 */

import { describe, expect, it } from 'vitest';
import { DomainSerializer } from '../src/language-server/domain-serializer.js';
import { type DomainModel, type ProcessModel } from '../src/language-server/ast.js';
import { ProcessSerializer } from '../src/language-server/process-serializer.js';
import { documentFor, makeWorkspaceHarness, type OrderFlowHarness, workspaceUri } from './order-flow-harness.js';

/** Serialize a workspace document through the serializer its URI routes to. */
async function serialize(harness: OrderFlowHarness, relativePath: string): Promise<string> {
   const services = harness.shared.ServiceRegistry.getServices(workspaceUri(relativePath));
   const document = documentFor(harness, relativePath);
   return services.serializer.Serializer.serializeAst(document.parseResult.value);
}

describe('order-flow serializers — one per grammar, routed per URI', () => {
   it('routes .domain and .process to different serializer implementations', async () => {
      const harness = await makeWorkspaceHarness();

      expect(harness.shared.ServiceRegistry.getServices(workspaceUri('orders/orders.domain')).serializer.Serializer).toBeInstanceOf(
         DomainSerializer
      );
      expect(harness.shared.ServiceRegistry.getServices(workspaceUri('orders/fulfillment.process')).serializer.Serializer).toBeInstanceOf(
         ProcessSerializer
      );
   });

   it('emits the project header, the public modifier and the array marker', async () => {
      const harness = await makeWorkspaceHarness();

      expect(await serialize(harness, 'orders/orders.domain')).toBe(
         [
            'project orders requires commerce-core',
            '',
            'entity Order {',
            '   id: ID',
            '   status: OrderStatus',
            '   total: Money',
            '   shipTo: Address',
            '   lines: LineItem[]',
            '}',
            '',
            'enum OrderStatus { NEW, PAID, SHIPPED, CANCELLED }',
            '',
            'entity LineItem {',
            '   sku: ID',
            '   quantity: Number',
            '   price: Money',
            '}'
         ].join('\n')
      );
   });

   it('emits public declarations with their modifier', async () => {
      const harness = await makeWorkspaceHarness();

      expect(await serialize(harness, 'commerce-core/money.domain')).toContain('public valuetype Money {');
      expect(await serialize(harness, 'commerce-core/internal.domain')).toContain('entity AuditStamp {');
      expect(await serialize(harness, 'commerce-core/internal.domain')).not.toContain('public');
   });

   it('emits effects one per line, and gateway branches under their gateway', async () => {
      const harness = await makeWorkspaceHarness();

      expect(await serialize(harness, 'orders/fulfillment.process')).toBe(
         [
            'process Fulfillment for Order {',
            '   task Pay',
            '      writes Order.status = PAID',
            '   gateway PaymentOk',
            '      yes -> Pick',
            '      no -> Cancel',
            '   task Pick',
            '      reads Order.id',
            '   task Ship',
            '      writes Order.status = SHIPPED',
            '   task Cancel',
            '      writes Order.status = CANCELLED',
            '   transition Pay -> PaymentOk',
            '   transition Pick -> Ship',
            // No layout here: positions live in `fulfillment.layout` and
            // round-trip through the `.layout` serializer.
            '}'
         ].join('\n')
      );
   });

   it('emits the layout file through its own serializer, routed by extension', async () => {
      const harness = await makeWorkspaceHarness();

      // The third serializer, and the one that makes per-URI routing more than
      // plumbing: a single GLSP operation writes a `.process` and a `.layout`,
      // so one user gesture resolves two different serializers by URI.
      expect(await serialize(harness, 'orders/fulfillment.layout')).toBe(
         [
            'layout FulfillmentLayout for Fulfillment {',
            // `Cancel` has no entry, which is the state the emitter has to leave
            // alone rather than default to 0, 0.
            '   node Pay at 40, 100 size 160, 60',
            // Position and no size, which the emitter has to leave partial
            // rather than complete with a default.
            '   node PaymentOk at 260, 90',
            '   node Pick at 440, 200 size 160, 60',
            '   node Ship at 660, 200 size 160, 60',
            '}'
         ].join('\n')
      );
   });

   it('serializes the transfer projection byte-identically to the AST', async () => {
      // The data head's write path (`DataServer.updateModelDocument` →
      // `ModelService.update` → `modelToText`) hands the serializer a TRANSFER model,
      // where every cross-reference is a plain string id rather than a Langium
      // `Reference`. The serializers here replace the generic property walker with
      // hand-written per-`$type` emitters, so nothing about that shape is exercised by
      // the AST-mode assertions above.
      //
      // The two shapes can diverge silently, and the failure mode is severe: a
      // transfer-mode emitter that reaches for `.ref` writes `writes Order.status = PAID`
      // back as `writes . = `, so a form-editor save blanks every reference in the file.
      // The comparison is byte-for-byte on purpose; anything weaker (a re-parse, a node
      // count) passes on exactly that corruption, because the damaged text still parses.
      const harness = await makeWorkspaceHarness();
      const encoder = harness.shared.model.TransferEncoder;

      for (const relativePath of [
         'orders/orders.domain',
         'commerce-core/money.domain',
         'orders/fulfillment.process',
         'orders/returns.process'
      ]) {
         const services = harness.shared.ServiceRegistry.getServices(workspaceUri(relativePath));
         const root = documentFor(harness, relativePath).parseResult.value;
         const fromTransfer = await services.serializer.Serializer.serializeTransfer(encoder.toTransfer(root, 'grammar'));
         expect(fromTransfer, relativePath).toBe(await services.serializer.Serializer.serializeAst(root));
      }
   });

   it('round-trips both grammars through a re-parse', async () => {
      const harness = await makeWorkspaceHarness();

      const domainText = await serialize(harness, 'orders/orders.domain');
      const reparsedDomain = harness.domain.parser.LangiumParser.parse<DomainModel>(domainText);
      expect(reparsedDomain.lexerErrors).toHaveLength(0);
      expect(reparsedDomain.parserErrors).toHaveLength(0);
      expect(reparsedDomain.value.project?.name).toBe('orders');
      expect(reparsedDomain.value.declarations.map(declaration => declaration.name)).toEqual(['Order', 'OrderStatus', 'LineItem']);

      const processText = await serialize(harness, 'orders/fulfillment.process');
      const reparsedProcess = harness.process.parser.LangiumParser.parse<ProcessModel>(processText);
      expect(reparsedProcess.lexerErrors).toHaveLength(0);
      expect(reparsedProcess.parserErrors).toHaveLength(0);
      expect(reparsedProcess.value.nodes.map(node => node.name)).toEqual(['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel']);
      expect(reparsedProcess.value.transitions).toHaveLength(2);
   });
});
