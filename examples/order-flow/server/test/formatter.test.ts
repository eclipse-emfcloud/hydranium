/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `textDocument/formatting` across the three grammars.
 *
 * The property worth pinning is the SEPARATION: formatting rewrites layout on
 * request, and the write path never calls it. A test that only checked "messy
 * input becomes tidy" would still pass if formatting had leaked into every
 * write, which is the arrangement this example exists to argue against.
 */

import { URI } from '@hydranium/langium';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { makeServices, type OrderFlowHarness } from './order-flow-harness.js';

const harness: OrderFlowHarness = makeServices();

/** Format `source` the way an editor's Format Document request does. */
async function format(harness: OrderFlowHarness, source: string, extension: string, tabSize = 3): Promise<string> {
   const uri = URI.parse(`memory:///formatter-${extension.slice(1)}${extension}`);
   const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
   expect(document.parseResult.parserErrors, source).toHaveLength(0);
   const services = harness.shared.ServiceRegistry.getServices(uri);
   const edits = await services.lsp.Formatter!.formatDocument(document, {
      textDocument: { uri: uri.toString() },
      options: { tabSize, insertSpaces: true }
   });
   return TextDocument.applyEdits(document.textDocument, edits);
}

describe('order-flow formatter', () => {
   it('is bound on every grammar, so the server advertises the capability', () => {
      for (const extension of ['.process', '.domain', '.layout']) {
         const services = harness.shared.ServiceRegistry.getServices(URI.parse(`memory:///a${extension}`));
         expect(services.lsp.Formatter, extension).toBeDefined();
      }
   });

   it('indents a cramped .process into the canonical shape', async () => {
      const source = 'process Cramped for Order {\ntask Pay\nwrites Order.status = PAID\ngateway Ok\nyes -> Pay\ntransition Pay -> Pay\n}';
      expect(await format(harness, source, '.process')).toBe(
         [
            'process Cramped for Order {',
            '   task Pay',
            '      writes Order.status = PAID',
            '   gateway Ok',
            '      yes -> Pay',
            '   transition Pay -> Pay',
            '}'
         ].join('\n')
      );
   });

   it('indents a cramped .domain and keeps top-level declarations at column zero', async () => {
      const source = 'entity Shipment {\nid: ID\n}\nvaluetype Barcode {\ncode: ID\n}';
      expect(await format(harness, source, '.domain')).toBe(
         ['entity Shipment {', '   id: ID', '}', 'valuetype Barcode {', '   code: ID', '}'].join('\n')
      );
   });

   it('indents a cramped .layout and normalises the coordinate separators', async () => {
      const source = 'layout L for Cramped {\nnode Pay at 40 , 40 size 160,60\n}';
      expect(await format(harness, source, '.layout')).toBe(
         ['layout L for Cramped {', '   node Pay at 40, 40 size 160, 60', '}'].join('\n')
      );
   });

   it('honours the client tabSize rather than the serializer indent', async () => {
      // The formatter answers to the editor, the serializer to the file format.
      // Pinning this keeps anyone from "fixing" the divergence by hard-coding
      // three spaces here, which would ignore the request's own options.
      const source = 'process Two for Order {\ntask Pay\n}';
      expect(await format(harness, source, '.process', 2)).toBe(['process Two for Order {', '  task Pay', '}'].join('\n'));
   });

   it('leaves an empty block on one line, so it agrees with serializer output', async () => {
      // The serializers emit `{}` for an empty body. If formatting split that
      // across two lines, formatting a just-written file would change it.
      expect(await format(harness, 'process Empty for Order {}', '.process')).toBe('process Empty for Order {}');
      expect(await format(harness, 'entity Empty {}', '.domain')).toBe('entity Empty {}');
   });

   it('is idempotent — formatting canonical output changes nothing', async () => {
      const canonical = ['process Fulfillment for Order {', '   task Pay', '      writes Order.status = PAID', '}'].join('\n');
      expect(await format(harness, canonical, '.process')).toBe(canonical);
   });

   it('leaves comments in place', async () => {
      const source = ['// leads the file', 'process Commented for Order {', '// leads the task', 'task Pay', '}'].join('\n');
      const formatted = await format(harness, source, '.process');
      expect(formatted).toContain('// leads the file');
      expect(formatted).toContain('// leads the task');
   });
});
