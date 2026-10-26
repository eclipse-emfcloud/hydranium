/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { beforeEach, describe, expect, it } from 'vitest';
import {
   type AstNode,
   type AstNodeLocator,
   type CstNode,
   type LangiumCoreServices,
   type LangiumDocument,
   type NameProvider
} from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import {
   DefaultTieredAstNodeDescription,
   HydraniumAstNodeDescriptionProvider
} from '../../../src/langium/scope/ast-node-description-provider.js';
import { isLocalTier, isTieredDescription } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeAstNode, makeNoopTracer } from '../../../src/testing/index.js';

interface FakeNode extends AstNode {
   readonly $type: string;
   readonly name?: string;
}

function fakeDocument(uri: string = 'file:///fake.test'): LangiumDocument {
   return { uri: URI.parse(uri) } as LangiumDocument;
}

const noopLogger: { for: () => typeof noopLogger; trace: () => void } = {
   for: () => noopLogger,
   trace: () => undefined
};

function makeServices(
   overrides: { getNameNode?: NameProvider['getNameNode']; rehydrateNode?: (node: AstNode) => void } = {}
): LangiumCoreServices {
   const astNodeLocator: AstNodeLocator = {
      getAstNodePath: () => '/0',
      getAstNode: () => undefined
   };
   const nameProvider: NameProvider = {
      getName: (node: AstNode) => (node as FakeNode).name,
      getNameNode: overrides.getNameNode ?? (() => undefined)
   };
   return {
      references: { NameProvider: nameProvider },
      workspace: { AstNodeLocator: astNodeLocator },
      shared: {
         Logger: noopLogger,
         Tracer: makeNoopTracer(),
         workspace: { CstResidencyService: { rehydrateNode: overrides.rehydrateNode ?? (() => undefined) } }
      }
   } as unknown as LangiumCoreServices;
}

describe('HydraniumAstNodeDescriptionProvider', () => {
   const services = makeServices();
   const provider = new HydraniumAstNodeDescriptionProvider(services as never);

   describe('createLocal', () => {
      it('produces `tier: local`, no projectId, document URI preserved', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument('file:///a/foo.test');
         const description = provider.createLocal({ node, name: 'foo', document });
         expect(isTieredDescription(description)).toBe(true);
         expect(description.tier).toBe('local');
         expect(description.projectId).toBeUndefined();
         expect(description.name).toBe('foo');
         expect(description.documentUri.toString()).toBe('file:///a/foo.test');
      });
   });

   describe('createProject', () => {
      it('produces `tier: project` with required projectId', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createProject({ node, name: 'foo', document, projectId: 'dm1' });
         expect(description.tier).toBe('project');
         expect(description.projectId).toBe('dm1');
      });
   });

   describe('createPublic', () => {
      it('produces `tier: public` with required projectId (the multi-tier emission contract)', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createPublic({ node, name: 'foo', document, projectId: 'dm1' });
         expect(description.tier).toBe('public');
         expect(description.projectId).toBe('dm1');
      });
   });

   describe('createUniversal', () => {
      it('produces `tier: universal` with no projectId', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createUniversal({ node, name: 'foo', document });
         expect(description.tier).toBe('universal');
         expect(description.projectId).toBeUndefined();
      });
   });

   describe('createDescription as the provider overrides it', () => {
      it('produces a local-tier description, so no un-tiered description escapes the provider', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createDescription(node, 'foo', document);
         expect(isTieredDescription(description)).toBe(true);
         expect(isLocalTier(description)).toBe(true);
      });

      it("falls back to the name provider's name when called without one, as Langium's callers may", () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         expect(provider.createDescription(node, undefined, fakeDocument()).name).toBe('foo');
      });

      it('builds through newDescription, so a subclass that overrides only it gets its own description class', () => {
         class OwnDescription extends DefaultTieredAstNodeDescription {}
         class OwnProvider extends HydraniumAstNodeDescriptionProvider {
            protected override newDescription(
               ...args: Parameters<HydraniumAstNodeDescriptionProvider['newDescription']>
            ): DefaultTieredAstNodeDescription {
               return new OwnDescription(this, ...args);
            }
         }
         const own = new OwnProvider(services as never);
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const description = own.createProject({ node, name: 'foo', document: fakeDocument(), projectId: 'dm1' });
         expect(description).toBeInstanceOf(OwnDescription);
         expect(description.projectId).toBe('dm1');
      });

      it('throws for a node without a name', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X' });
         expect(() => provider.createDescription(node, undefined, fakeDocument())).toThrow('Node at path /0 has no name.');
      });
   });
});

describe('DefaultTieredAstNodeDescription', () => {
   const cstNode = { offset: 4, end: 7, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } } } as CstNode;
   let nameNodeReads = 0;
   let rehydrations = 0;
   beforeEach(() => {
      nameNodeReads = 0;
      rehydrations = 0;
   });
   const services = makeServices({
      getNameNode: (node: AstNode) => {
         nameNodeReads++;
         return node.$cstNode === undefined ? undefined : cstNode;
      },
      rehydrateNode: (node: AstNode & { $cstNode?: CstNode }) => {
         rehydrations++;
         // A node named `unrestorable` stands for a CST rehydration cannot restore.
         if ((node as FakeNode).name !== 'unrestorable') {
            node.$cstNode = cstNode;
         }
      }
   });
   const provider = new HydraniumAstNodeDescriptionProvider(services as never);
   const document = fakeDocument();

   it('builds the same own fields in the same order for every tier', () => {
      const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
      const descriptions = [
         provider.createLocal({ node, name: 'foo', document }),
         provider.createProject({ node, name: 'foo', document, projectId: 'dm1' }),
         provider.createPublic({ node, name: 'foo', document, projectId: 'dm1' }),
         provider.createUniversal({ node, name: 'foo', document })
      ];
      for (const description of descriptions) {
         expect(description).toBeInstanceOf(DefaultTieredAstNodeDescription);
         expect(Object.keys(description)).toEqual(Object.keys(descriptions[0]));
      }
   });

   it('restores a shed CST before computing nameSegment, on its first read only', () => {
      const description = provider.createLocal({ node: makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' }), name: 'foo', document });
      expect(nameNodeReads).toBe(0);
      expect(description.nameSegment?.offset).toBe(4);
      expect(description.nameSegment?.offset).toBe(4);
      expect(nameNodeReads).toBe(1);
      expect(rehydrations).toBe(1);
   });

   it('restores a shed CST before computing selectionSegment, on its first read only', () => {
      const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
      const description = provider.createLocal({ node, name: 'foo', document });
      expect(rehydrations).toBe(0);
      expect(description.selectionSegment?.end).toBe(7);
      expect(description.selectionSegment?.end).toBe(7);
      expect(rehydrations).toBe(1);
   });

   it('does not try again to restore a CST it could not restore', () => {
      const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'unrestorable' });
      const description = provider.createLocal({ node, name: 'unrestorable', document });
      expect(description.selectionSegment).toBeUndefined();
      expect(description.selectionSegment).toBeUndefined();
      expect(rehydrations).toBe(1);
   });

   it('computes an absent segment again once the node has a CST again', () => {
      const node = makeFakeAstNode<FakeNode & { $cstNode?: CstNode }>({ $type: 'X', name: 'unrestorable' });
      const description = provider.createLocal({ node, name: 'unrestorable', document });
      expect(description.nameSegment).toBeUndefined();
      expect(description.selectionSegment).toBeUndefined();
      node.$cstNode = cstNode;
      expect(description.nameSegment?.offset).toBe(4);
      expect(description.selectionSegment?.end).toBe(7);
   });
});
