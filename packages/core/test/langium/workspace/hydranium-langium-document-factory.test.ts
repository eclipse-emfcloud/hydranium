/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, DefaultLinker, type LangiumCoreServices, type Reference, URI } from '@hydranium/langium';
import { DefaultModelLedger } from '../../../src/documents/model-ledger.js';
import { DefaultVersionSyncService } from '../../../src/documents/version-sync-service.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';
import { HydraniumLangiumDocumentFactory } from '../../../src/langium/workspace/hydranium-langium-document-factory.js';
import { makeFakeAstNode, makeNoopTracer } from '../../../src/testing/index.js';

interface NamedNode extends AstNode {
   name: string;
}

/** Langium's linker, with no scope: these tests only build and unlink references. */
const linker = new DefaultLinker({
   shared: { AstReflection: undefined, workspace: {}, profilers: {} },
   references: {},
   workspace: {},
   LanguageMetaData: { languageId: 'test' }
} as unknown as LangiumCoreServices);

function factoryWith(serializeAst?: (node: AstNode) => string): HydraniumLangiumDocumentFactory {
   const services = {
      Tracer: makeNoopTracer(),
      ServiceRegistry: {
         getServices: (_uri: URI) => ({
            LanguageMetaData: { languageId: 'test' },
            shared: { AstReflection: { getTypeMetaData: () => ({ properties: {} }) } },
            serializer: serializeAst ? { Serializer: { serializeAst } } : undefined,
            references: { Linker: linker }
         })
      },
      workspace: {
         TextDocuments: undefined,
         FileSystemProvider: {},
         ModelLedger: new DefaultModelLedger(),
         VersionSyncService: undefined as unknown
      }
   } as unknown as ServerSharedServices;
   services.workspace.VersionSyncService = new DefaultVersionSyncService(services);
   return new HydraniumLangiumDocumentFactory(services);
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

   it('rebuilds code-set references through the linker, keeping their targets and listing them', () => {
      const factory = factoryWith(node => `serialized:${(node as NamedNode).name}`);
      const { root, child } = makeTree();
      // The shape a reference builder returns, which neither a relink nor the reference index reads.
      Object.assign(root, { base: { $refText: 'Any', ref: child }, bases: [{ $refText: 'Any', ref: child }] });
      const doc = factory.fromModel(root, URI.parse('virtual:x'));
      const { base, bases } = root as AstNode & { base: Reference; bases: Reference[] };
      const [listedBase, listedElement] = doc.references;
      expect(listedBase).toBe(base);
      expect(listedElement).toBe(bases[0]);
      expect([base.ref, bases[0].ref]).toEqual([child, child]);
      linker.unlink(doc);
      // Unlinked, a linker-built reference resolves through the scope again. A literal has no such field.
      expect([base, bases[0]].map(reference => '_ref' in reference && reference._ref === undefined)).toEqual([true, true]);
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
