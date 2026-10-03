/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, DocumentState, URI } from '@hydranium/langium';
import { UNRECORDED_VERSION } from '@hydranium/protocol';
import { makeFakeAstNode } from '../../src/testing/index.js';
import { makeTestServices } from '../../src/testing/make-test-services.js';

const URI_ONE = 'file:///a.x';

describe('StubAstDocumentManager.toAstDocument', () => {
   it('answers an unrecorded root at no version and an unvalidated document without diagnostics, as the real manager does', () => {
      const bundle = makeTestServices<AstNode>({
         seedDocuments: [{ uri: URI_ONE, root: makeFakeAstNode<AstNode>({ $type: 'TypeOne' }), options: { state: DocumentState.Linked } }]
      });
      bundle.textDocuments.seedOpen(URI_ONE, 'name: a\n', 'client-a');
      const document = bundle.documents.getDocument(URI.parse(URI_ONE))!;
      document.diagnostics = undefined;

      const answer = bundle.astDocumentManager.toAstDocument(document);

      expect({ version: answer.version, diagnostics: 'diagnostics' in answer }).toEqual({
         version: UNRECORDED_VERSION,
         diagnostics: false
      });
   });
});
