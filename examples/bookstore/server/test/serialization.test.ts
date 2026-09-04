/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Round-trips each grammar through its serializer: parse the source, serialize
// the model, compare the text. The serializer is the parser's inverse, so this
// is the assertion that keeps `ModelService.update` / `save` writing files the
// language server can read back.
//
// The transfer case is the one that catches the mistake worth catching.
// `ModelService.modelToText` short-circuits only a RAW STRING, so a typed model
// from the data head reaches `serializeTransfer` — where a cross-reference is a
// plain string, not a `Reference`.

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
import type { BookstoreModel } from '../src/language-server/ast.js';
import type { BookstoreModel as TransferBookstoreModel } from '../src/language-server/generated-transfer/transfer-model.js';
import { createServices } from '../src/services.js';

describe('Bookstore serialization', () => {
   const source = 'node first -> second\nnode second';

   it('round-trips parsed source back to the same text', async () => {
      const { Bookstore } = createServices();

      const document = await parseHelper<BookstoreModel>(Bookstore)(source, { documentUri: 'file:///round-trip.bookstore' });

      expect(document.parseResult.parserErrors).toHaveLength(0);
      expect(await Bookstore.serializer.Serializer.serializeAst(document.parseResult.value)).toBe(source);
   });

   it('emits the same text from a transfer model, whose references are plain strings', async () => {
      const { Bookstore } = createServices();
      const model: TransferBookstoreModel = {
         $type: 'BookstoreModel',
         nodes: [
            { $type: 'BookstoreNode', name: 'first', target: 'second' },
            { $type: 'BookstoreNode', name: 'second' }
         ]
      };

      expect(await Bookstore.serializer.Serializer.serializeTransfer(model)).toBe(source);
   });
});
