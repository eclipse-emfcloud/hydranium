/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type AstNodeLocator, type LangiumCoreServices, type LangiumDocument, type NameProvider } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { HydraniumAstNodeDescriptionProvider } from '../../../src/langium/scope/ast-node-description-provider.js';
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

function makeServices(): LangiumCoreServices {
   const astNodeLocator: AstNodeLocator = {
      getAstNodePath: () => '/0',
      getAstNode: () => undefined
   };
   const nameProvider: NameProvider = {
      getName: (node: AstNode) => (node as FakeNode).name,
      getNameNode: () => undefined
   };
   return {
      references: { NameProvider: nameProvider },
      workspace: { AstNodeLocator: astNodeLocator },
      shared: { Logger: noopLogger, Tracer: makeNoopTracer() }
   } as unknown as LangiumCoreServices;
}

describe('HydraniumAstNodeDescriptionProvider', () => {
   const services = makeServices();
   const provider = new HydraniumAstNodeDescriptionProvider(services as never);

   describe('createLocal', () => {
      it('produces tier: local, no projectId, document URI preserved', () => {
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
      it('produces tier: project with required projectId', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createProject({ node, name: 'foo', document, projectId: 'dm1' });
         expect(description.tier).toBe('project');
         expect(description.projectId).toBe('dm1');
      });
   });

   describe('createPublic', () => {
      it('produces tier: public with required projectId (the multi-tier emission contract)', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createPublic({ node, name: 'foo', document, projectId: 'dm1' });
         expect(description.tier).toBe('public');
         expect(description.projectId).toBe('dm1');
      });
   });

   describe('createUniversal', () => {
      it('produces tier: universal with no projectId', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createUniversal({ node, name: 'foo', document });
         expect(description.tier).toBe('universal');
         expect(description.projectId).toBeUndefined();
      });
   });

   describe('createDescription (overridden)', () => {
      it('produces a local-tier description — no un-tiered descriptions escape the provider', () => {
         const node = makeFakeAstNode<FakeNode>({ $type: 'X', name: 'foo' });
         const document = fakeDocument();
         const description = provider.createDescription(node, 'foo', document);
         expect(isTieredDescription(description)).toBe(true);
         expect(isLocalTier(description)).toBe(true);
      });
   });
});
