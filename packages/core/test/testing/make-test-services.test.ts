/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeTestServices` — the wiring of the bundle, not the behaviour of the
 * stubs it composes.
 *
 * Each bundled double now has its own named differential file, so the blocks
 * that used to exercise them from here were removed rather than kept: an
 * isolation test a differential supersedes certifies whatever the stub happens
 * to do, which is the failure the differentials exist to close. What survives
 * is what only the assembler can get wrong — which slot holds which double,
 * which slots stay ABSENT, and which of the two serializer paths a bundle picks.
 */

import { describe, expect, it } from 'vitest';
import type { TransferDiagnostic } from '@hydranium/protocol';
import { URI, type AstNode } from '@hydranium/langium';
import { makeFakeAstNode, makeFakeDescription, makeTestServices } from '../../src/testing/index.js';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const URI_A = 'file:///A.fake';

describe('makeTestServices', () => {
   it('wires every slot of ServerSharedServices the framework reads from', () => {
      const bundle = makeTestServices<FakeRoot, TransferDiagnostic, FakeRoot>({
         serialize: (_uri, root) => `name:${root.name}`,
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
         seedProjects: [{ id: 'p1', referenceName: 'p1' }]
      });
      expect(bundle.services.Logger).toBe(bundle.logger);
      expect(bundle.services.workspace.LangiumDocuments).toBe(bundle.documents);
      expect(bundle.services.workspace.DocumentBuilder).toBe(bundle.documentBuilder);
      expect(bundle.services.workspace.TextDocuments).toBe(bundle.textDocuments);
      expect(bundle.services.workspace.FileSystemProvider).toBe(bundle.fileSystem);
      expect(bundle.services.workspace.SelfSaveRegistry).toBe(bundle.selfSaveRegistry);
      expect(bundle.services.workspace.ProjectManager).toBe(bundle.projectManager);
      expect(bundle.services.model.TransferEncoder).toBe(bundle.transferEncoder);
      expect(bundle.services.model.ModelService).toBe(bundle.modelService);
      expect(bundle.documents.hasDocument(URI.parse(URI_A))).toBe(true);
      expect(bundle.projectManager.getProjectById('p1')?.id).toBe('p1');
   });

   it('binds the IndexManager slot only when an index is seeded, and leaves it absent otherwise', () => {
      // Absent, not present-and-undefined: a global-index read must fail on
      // the unbound slot rather than be answered with an empty result, which
      // would let a suite that never asked for an index pass for a new reason.
      const withoutIndex = makeTestServices<FakeRoot>();
      expect(withoutIndex.indexManager).toBeUndefined();
      expect('IndexManager' in withoutIndex.services.workspace).toBe(false);

      const seeded = makeTestServices<FakeRoot>({ seedIndex: [makeFakeDescription('Seeded', { type: 'FakeRoot' })] });
      expect(seeded.services.workspace.IndexManager).toBe(seeded.indexManager);
      expect(
         seeded.indexManager
            ?.allElements('FakeRoot')
            .toArray()
            .map(description => description.name)
      ).toEqual(['Seeded']);
      expect(seeded.indexManager?.allElements('Other').toArray()).toEqual([]);
   });

   it('uses the provided modelService factory when supplied', () => {
      const sentinel = Symbol('sentinel');
      const bundle = makeTestServices<FakeRoot>({
         modelService: services =>
            // Cheapest sentinel — the bundle just plumbs whatever the factory returns.
            ({ services, sentinel }) as unknown as ReturnType<typeof makeTestServices<FakeRoot>>['modelService']
      });
      expect((bundle.modelService as unknown as { sentinel: symbol }).sentinel).toBe(sentinel);
   });

   it('default serializer uses JSON.stringify when no callback is supplied', () => {
      const bundle = makeTestServices<FakeRoot>();
      // `toBeDefined()` on two unconditionally-assigned fields is green
      // against a default of `() => ''` — the serializer's OUTPUT is what the
      // title claims, so the output is what has to be read. `serialize` is
      // protected, hence the structural cast.
      const serialize = (bundle.modelService as unknown as { serialize(uri: string, root: unknown): string }).serialize.bind(
         bundle.modelService
      );
      const root = { $type: 'FakeRoot', name: 'from-default' };

      expect(serialize(URI_A, root)).toBe(JSON.stringify(root));
   });

   it('an explicit serialize callback replaces the default and receives the uri', () => {
      const seen: string[] = [];
      const bundle = makeTestServices<FakeRoot>({
         serialize: (uri: string) => {
            seen.push(uri);
            return 'adopter-text';
         }
      });
      const serialize = (bundle.modelService as unknown as { serialize(uri: string, root: unknown): string }).serialize.bind(
         bundle.modelService
      );

      expect(serialize(URI_A, { $type: 'FakeRoot', name: 'ignored' })).toBe('adopter-text');
      expect(seen).toEqual([URI_A]);
   });
});
