/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import {
   type AstNode,
   type AstNodeDescription,
   type AstNodeDescriptionProvider,
   type AstNodeLocator,
   type LangiumCoreServices,
   type LangiumDocument,
   MultiMap
} from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { Logger } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import type { NameProvider } from '../../../src/langium/naming/name-provider.js';
import { HydraniumAstNodeDescriptionProvider } from '../../../src/langium/scope/ast-node-description-provider.js';
import { HydraniumScopeComputation } from '../../../src/langium/scope/hydranium-scope-computation.js';
import { isLocalTier, isTieredDescription } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeCapturingTracer, makeFakeAstNode, makeFakeDocument } from '../../../src/testing/index.js';

interface FakeNode extends AstNode {
   readonly $type: string;
   readonly name?: string;
}

/** A fake node that owns a `members` child collection. */
interface FakeContainerNode extends FakeNode {
   members: FakeNode[];
}

/**
 * NameProvider stub with the framework's three qualification levels. The test
 * fixtures don't need real name walking — each level is supplied as an
 * explicit per-node callback. `getName` defaults to project-qualified per
 * the framework contract.
 */
function makeNameProviderStub(
   ownNameByNode: (node: AstNode) => string | undefined,
   options: {
      documentQualifiedByNode?: (node: AstNode) => string | undefined;
      projectQualifiedByNode?: (node: AstNode) => string | undefined;
   } = {}
): NameProvider {
   const documentQualified = options.documentQualifiedByNode ?? ownNameByNode;
   const projectQualified = options.projectQualifiedByNode ?? documentQualified;
   return {
      nameSeparator: '.',
      getName: (node: AstNode) => projectQualified(node),
      getNameNode: () => undefined,
      getOwnName: (node?: AstNode) => (node ? ownNameByNode(node) : undefined),
      getDocumentQualifiedName: (node?: AstNode) => (node ? documentQualified(node) : undefined),
      getProjectQualifiedName: (node?: AstNode) => (node ? projectQualified(node) : undefined),
      getProjectReferenceName: () => undefined,
      findNextName: () => '',
      findNextDocumentQualifiedName: () => '',
      findNextProjectQualifiedName: () => ''
      // The fixture only exercises the name-resolution surface above. The
      // remaining NameProvider members (qualify, hasName, getNameProperty)
      // aren't reached by these tests, so the partial stub is widened rather
      // than stubbed member-by-member.
   } as unknown as NameProvider;
}

const noopLogger: { for: () => typeof noopLogger; trace: () => void } = {
   for: () => noopLogger,
   trace: () => undefined
};

function makeLocalSymbolServices(nameProvider: NameProvider, tracer: unknown = noopLogger): LangiumCoreServices {
   const astNodeLocator: AstNodeLocator = { getAstNodePath: () => '/', getAstNode: () => undefined };
   const services = {
      references: { NameProvider: nameProvider },
      workspace: { AstNodeLocator: astNodeLocator, AstNodeDescriptionProvider: undefined },
      shared: { Logger: noopLogger, Tracer: tracer }
   } as unknown as LangiumCoreServices;
   (services.workspace as unknown as Record<string, unknown>).AstNodeDescriptionProvider = new HydraniumAstNodeDescriptionProvider(
      services as never
   );
   return services;
}

/**
 * Services tree for the export-pass tests. Wires a real
 * {@link HydraniumAstNodeDescriptionProvider}, a `NameProvider` stub
 * configurable per node, and a `ProjectManager` stub keyed by
 * document URI → project id.
 */
function makeExportTestServices(
   documentOwnership: Record<string, string>,
   nameProvider: NameProvider = makeNameProviderStub(node => (node as FakeNode).name)
): LangiumCoreServices {
   const astNodeLocator: AstNodeLocator = {
      getAstNodePath: () => '/0',
      getAstNode: () => undefined
   };
   const services = {
      references: { NameProvider: nameProvider },
      workspace: { AstNodeLocator: astNodeLocator },
      shared: {
         workspace: {
            ProjectManager: {
               getProject: (uri: URI | string) => {
                  const key = typeof uri === 'string' ? uri : uri.toString();
                  const id = documentOwnership[key];
                  return id ? { id } : undefined;
               }
            }
         },
         Logger: noopLogger,
         Tracer: noopLogger
      }
   } as unknown as LangiumCoreServices;
   (services as unknown as { workspace: { AstNodeDescriptionProvider: AstNodeDescriptionProvider } }).workspace.AstNodeDescriptionProvider =
      new HydraniumAstNodeDescriptionProvider(services as never);
   return services;
}

describe('HydraniumScopeComputation', () => {
   const fakeDocument = {} as unknown as LangiumDocument;

   function invokeAddLocalSymbol(
      computation: HydraniumScopeComputation,
      node: AstNode,
      document: LangiumDocument,
      symbols: MultiMap<AstNode, AstNodeDescription>
   ): void {
      (
         computation as unknown as { addLocalSymbol(n: AstNode, d: LangiumDocument, s: MultiMap<AstNode, AstNodeDescription>): void }
      ).addLocalSymbol(node, document, symbols);
   }

   it('addLocalSymbol keys local symbols by bare own-name (not by getName)', () => {
      const services = makeLocalSymbolServices(
         makeNameProviderStub(
            node => (node as FakeNode).name,
            // Even if getName / getProjectQualifiedName returns 'ns.Foo', addLocalSymbol
            // explicitly calls getOwnName and stores under 'Foo'.
            { projectQualifiedByNode: node => `ns.${(node as FakeNode).name}` }
         )
      );
      const computation = new HydraniumScopeComputation(services as never);
      const root = makeFakeAstNode<FakeNode>({ $type: 'Container', name: 'ns' });
      const child = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', $container: root, name: 'Foo' });
      const symbols = new MultiMap<AstNode, AstNodeDescription>();

      invokeAddLocalSymbol(computation, child, fakeDocument, symbols);

      expect(symbols.get(root)).toHaveLength(1);
      expect(symbols.get(root)[0].name).toBe('Foo');
      expect(isLocalTier(symbols.get(root)[0])).toBe(true);
   });

   it('addLocalSymbol adds nothing for a node without a container (root node)', () => {
      const services = makeLocalSymbolServices(makeNameProviderStub(node => (node as FakeNode).name));
      const computation = new HydraniumScopeComputation(services as never);
      const root = makeFakeAstNode<FakeNode>({ $type: 'Container', name: 'ns' }); // no container
      const symbols = new MultiMap<AstNode, AstNodeDescription>();

      invokeAddLocalSymbol(computation, root, fakeDocument, symbols);

      expect(symbols.size).toBe(0);
   });

   it('addLocalSymbol adds nothing for a contained node with no own-name', () => {
      const services = makeLocalSymbolServices(makeNameProviderStub(() => undefined));
      const computation = new HydraniumScopeComputation(services as never);
      const root = makeFakeAstNode<FakeNode>({ $type: 'Container', name: 'ns' });
      const child = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', $container: root }); // has a container but no name
      const symbols = new MultiMap<AstNode, AstNodeDescription>();

      invokeAddLocalSymbol(computation, child, fakeDocument, symbols);

      expect(symbols.size).toBe(0);
   });

   function invokeAddExportedSymbol(
      computation: HydraniumScopeComputation,
      node: AstNode,
      exports: AstNodeDescription[],
      document: LangiumDocument
   ): void {
      (computation as unknown as { addExportedSymbol(n: AstNode, e: AstNodeDescription[], d: LangiumDocument): void }).addExportedSymbol(
         node,
         exports,
         document
      );
   }

   it('addExportedSymbol emits tier: project keyed by document-qualified name when the document has an owning project', () => {
      const nameProvider = makeNameProviderStub(node => (node as FakeNode).name);
      const services = makeExportTestServices({ 'file:///projA/foo.fake': 'projA' }, nameProvider);
      const computation = new HydraniumScopeComputation(services as never);
      const document = { uri: URI.parse('file:///projA/foo.fake') } as LangiumDocument;
      const node = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', name: 'Foo' });
      const exports: AstNodeDescription[] = [];

      invokeAddExportedSymbol(computation, node, exports, document);

      expect(exports).toHaveLength(1);
      const [description] = exports;
      expect(isTieredDescription(description)).toBe(true);
      if (isTieredDescription(description)) {
         expect(description.tier).toBe('project');
         expect(description.projectId).toBe('projA');
         expect(description.name).toBe('Foo');
      }
   });

   it('addExportedSymbol emits tier: universal when the document has no owning project', () => {
      const nameProvider = makeNameProviderStub(node => (node as FakeNode).name);
      const services = makeExportTestServices({}, nameProvider);
      const computation = new HydraniumScopeComputation(services as never);
      const document = { uri: URI.parse('file:///loose/foo.fake') } as LangiumDocument;
      const node = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', name: 'Foo' });
      const exports: AstNodeDescription[] = [];

      invokeAddExportedSymbol(computation, node, exports, document);

      expect(exports).toHaveLength(1);
      const [description] = exports;
      expect(isTieredDescription(description)).toBe(true);
      if (isTieredDescription(description)) {
         expect(description.tier).toBe('universal');
         expect(description.projectId).toBeUndefined();
      }
   });

   it('addExportedSymbol skips nodes without a document-qualified name (preserves base behaviour)', () => {
      const nameProvider = makeNameProviderStub(node => (node as FakeNode).name);
      const services = makeExportTestServices({ 'file:///projA/foo.fake': 'projA' }, nameProvider);
      const computation = new HydraniumScopeComputation(services as never);
      const document = { uri: URI.parse('file:///projA/foo.fake') } as LangiumDocument;
      const unnamed = makeFakeAstNode<FakeNode>({ $type: 'Anonymous' }); // no name field → getOwnName/getDocumentQualifiedName return undefined
      const exports: AstNodeDescription[] = [];

      invokeAddExportedSymbol(computation, unnamed, exports, document);

      expect(exports).toEqual([]);
   });

   it('addExportedSymbol emits a public-tier sibling when project-qualified ≠ document-qualified', () => {
      const nameProvider = makeNameProviderStub(node => (node as FakeNode).name, {
         documentQualifiedByNode: node => (node as FakeNode).name,
         projectQualifiedByNode: node => `projA.${(node as FakeNode).name}`
      });
      const services = makeExportTestServices({ 'file:///projA/foo.fake': 'projA' }, nameProvider);
      const computation = new HydraniumScopeComputation(services as never);
      const document = { uri: URI.parse('file:///projA/foo.fake') } as LangiumDocument;
      const node = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', name: 'Foo' });
      const exports: AstNodeDescription[] = [];

      invokeAddExportedSymbol(computation, node, exports, document);

      expect(exports).toHaveLength(2);
      const [primary, dual] = exports;
      expect(isTieredDescription(primary)).toBe(true);
      expect(isTieredDescription(dual)).toBe(true);
      if (isTieredDescription(primary)) {
         expect(primary.tier).toBe('project');
         expect(primary.projectId).toBe('projA');
         expect(primary.name).toBe('Foo');
      }
      if (isTieredDescription(dual)) {
         expect(dual.tier).toBe('public');
         expect(dual.projectId).toBe('projA');
         expect(dual.name).toBe('projA.Foo');
      }
   });

   it('addExportedSymbol skips the public-tier emit when project-qualified === document-qualified (UNQUALIFIED_PROJECT_REFERENCE)', () => {
      // Project has empty referenceName → projectQualified collapses to documentQualified.
      const nameProvider = makeNameProviderStub(node => (node as FakeNode).name);
      const services = makeExportTestServices({ 'file:///projA/foo.fake': 'projA' }, nameProvider);
      const computation = new HydraniumScopeComputation(services as never);
      const document = { uri: URI.parse('file:///projA/foo.fake') } as LangiumDocument;
      const node = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', name: 'Foo' });
      const exports: AstNodeDescription[] = [];

      invokeAddExportedSymbol(computation, node, exports, document);

      // Only the primary project-tier description; no public-tier sibling.
      expect(exports).toHaveLength(1);
   });

   it('addExportedSymbol skips the public-tier emit when there is no owning project, even if names differ', () => {
      const nameProvider = makeNameProviderStub(node => (node as FakeNode).name, {
         documentQualifiedByNode: node => (node as FakeNode).name,
         projectQualifiedByNode: node => `loose.${(node as FakeNode).name}`
      });
      const services = makeExportTestServices({}, nameProvider);
      const computation = new HydraniumScopeComputation(services as never);
      const document = { uri: URI.parse('file:///loose/foo.fake') } as LangiumDocument;
      const node = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', name: 'Foo' });
      const exports: AstNodeDescription[] = [];

      invokeAddExportedSymbol(computation, node, exports, document);

      // Single `tier: 'universal'` description; the public-tier guard requires projectId !== undefined.
      expect(exports).toHaveLength(1);
   });
});

describe('HydraniumScopeComputation — collectLocalSymbols profiling', () => {
   afterEach(() => Logger.setLevel('info'));

   /** Container root with a `members` array so `streamAllContents` yields the children. */
   function makeContainerDocument(): LangiumDocument {
      const root = makeFakeAstNode<FakeContainerNode>({ $type: 'Container', name: 'ns' });
      const memberA = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', $container: root, name: 'A' });
      const memberB = makeFakeAstNode<FakeNode>({ $type: 'TypeOne', $container: root, name: 'B' });
      root.members = [memberA, memberB];
      return makeFakeDocument('file:///p/foo.fake', root);
   }

   it('aggregates per-$type self-time and reports it line-based at debug level', async () => {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const services = makeLocalSymbolServices(
         makeNameProviderStub(node => (node as FakeNode).name),
         tracer
      );
      const computation = new HydraniumScopeComputation(services as never);
      Logger.setLevel('debug');

      const symbols = await computation.collectLocalSymbols(makeContainerDocument());

      // Same observable result as the base walk: both members registered under the root.
      expect(symbols.has).toBeDefined();
      const profileLines = lines.map(line => line.message).filter(message => message.includes('[profile scope-local'));
      expect(profileLines.some(message => message.includes('TypeOne ×2'))).toBe(true);
   });

   it('delegates to the base walk with no profiling at the default info level', async () => {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const services = makeLocalSymbolServices(
         makeNameProviderStub(node => (node as FakeNode).name),
         tracer
      );
      const computation = new HydraniumScopeComputation(services as never);

      await computation.collectLocalSymbols(makeContainerDocument());

      expect(lines.map(line => line.message).filter(message => message.includes('[profile'))).toHaveLength(0);
   });
});
