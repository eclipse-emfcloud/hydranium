/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumSharedCoreServices, URI } from '@hydranium/langium';
import { HydraniumLangiumDocumentFactory } from '../../../src/langium/workspace/hydranium-langium-document-factory.js';
import { makeFakeAstNode } from '../../../src/testing/index.js';

interface NamedNode extends AstNode {
   name: string;
}

function factoryWith(serializeAst?: (node: AstNode) => string): HydraniumLangiumDocumentFactory {
   const services = {
      ServiceRegistry: {
         getServices: (_uri: URI) => ({
            LanguageMetaData: { languageId: 'test' },
            serializer: serializeAst ? { Serializer: { serializeAst } } : undefined
         })
      },
      workspace: { TextDocuments: undefined, FileSystemProvider: {} }
   };
   return new HydraniumLangiumDocumentFactory(services as unknown as LangiumSharedCoreServices);
}

const model = makeFakeAstNode<NamedNode>({ $type: 'Container', name: 'std' });

/** A rooted tree so container linking has descendants to link. */
function makeTree(): { root: AstNode; child: AstNode } {
   const child = makeFakeAstNode<AstNode>({ $type: 'TypeOne', name: 'Any' });
   const root = makeFakeAstNode<AstNode>({ $type: 'Container', name: 'std', members: [child] });
   return { root, child };
}

describe('HydraniumLangiumDocumentFactory.fromModel', () => {
   it('keeps the original model as the AST (identity preserved)', () => {
      const factory = factoryWith(node => `serialized:${(node as NamedNode).name}`);
      const doc = factory.fromModel(model, URI.parse('virtual:x'));
      expect(doc.parseResult.value).toBe(model);
   });

   it('links container properties so the code-built AST is indexable', () => {
      const factory = factoryWith(node => `serialized:${(node as NamedNode).name}`);
      const { root, child } = makeTree();
      factory.fromModel(root, URI.parse('virtual:std'));
      expect(child.$container).toBe(root);
      expect(child.$containerProperty).toBe('members');
      expect(child.$containerIndex).toBe(0);
   });

   it('links container properties even on the text-less fallback path', () => {
      const factory = factoryWith(undefined);
      const { root, child } = makeTree();
      factory.fromModel(root, URI.parse('virtual:std'));
      expect(child.$container).toBe(root);
      expect(child.$containerProperty).toBe('members');
   });

   it('retains serialized text so a virtual re-read can recover it', () => {
      const factory = factoryWith(node => `serialized:${(node as NamedNode).name}`);
      const doc = factory.fromModel(model, URI.parse('virtual:x'));
      expect(doc.textDocument.getText()).toBe('serialized:std');
   });

   it('falls back to a text-less document when no serializer is bound', () => {
      const factory = factoryWith(undefined);
      const doc = factory.fromModel(model, URI.parse('virtual:x'));
      expect(doc.parseResult.value).toBe(model);
      expect(doc.textDocument.getText()).toBe('');
   });

   it('falls back to a text-less document when the serializer throws', () => {
      const factory = factoryWith(() => {
         throw new Error('no Serializer registered');
      });
      const doc = factory.fromModel(model, URI.parse('virtual:x'));
      expect(doc.parseResult.value).toBe(model);
      expect(doc.textDocument.getText()).toBe('');
   });
});
