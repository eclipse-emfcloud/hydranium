/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { GModelElement } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container } from 'inversify';
import type { AstNode } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import type { ElementKeyProvider, ServerSharedServices } from '@hydranium/core';
import {
   type CapturedLine,
   makeCapturingLogger,
   makeFakeAstNode,
   makeNoopSharedServices,
   makeStubServiceRegistry
} from '@hydranium/core/testing';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';

function createIndex(idMap: Map<AstNode, string | undefined>): { index: HydraniumGlspIndex; lines: CapturedLine[] } {
   const elementKeyProvider: Pick<ElementKeyProvider, 'getElementKey'> = {
      getElementKey(node?: AstNode): string | undefined {
         return node ? idMap.get(node) : undefined;
      }
   };
   const { logger, lines } = makeCapturingLogger();
   // One registered language owning `.a`, so nodes route to the idMap-backed
   // key provider the way they do in a single-grammar adopter.
   const registry = makeStubServiceRegistry([
      { languageId: 'main', fileExtensions: ['.a'], services: { references: { ElementKeyProvider: elementKeyProvider } } }
   ]);
   const sharedServices = makeNoopSharedServices<ServerSharedServices>({ Logger: logger, ServiceRegistry: registry });
   const container = new Container();
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(sharedServices);
   container.bind(HydraniumGlspIndex).toSelf().inSingletonScope();
   return { index: container.get(HydraniumGlspIndex), lines };
}

/** A node in a routable document — the ordinary case. */
function makeAstNode(): AstNode {
   return makeAstNodeInDoc('file:///m/test.a');
}

/** A node with no `$document`, so nothing routes it. */
function makeDetachedAstNode(): AstNode {
   return makeFakeAstNode<AstNode>({ $type: 'TestNode' });
}

/** A root-level node carrying a `$document` so `AstUtils` can report its uri. */
function makeAstNodeInDoc(uri: string): AstNode {
   return makeFakeAstNode<AstNode>({ $type: 'TestNode', $document: { uri: URI.parse(uri) } });
}

function makeGModelElement(id: string): GModelElement {
   return Object.assign(Object.create(GModelElement.prototype) as GModelElement, {
      id,
      type: 'node',
      children: [] as GModelElement[]
   });
}

/**
 * An index over a two-language registry, each language keying nodes with its
 * own prefix. `.dgm` is the diagram's own language, `.other` a foreign one —
 * so a returned key names which language actually answered.
 */
function createMultiLanguageIndex(declaredLanguageUri?: string): HydraniumGlspIndex {
   return buildMultiLanguageIndex(declaredLanguageUri).index;
}

/**
 * As {@link createMultiLanguageIndex}, also reporting how many times the
 * registry's lookup ladder was walked — the cost the `indexSourceRoot` walk
 * must not pay per node.
 */
function buildMultiLanguageIndex(declaredLanguageUri?: string): { index: HydraniumGlspIndex; ladderWalks: () => number } {
   const keyProviderFor = (prefix: string): Pick<ElementKeyProvider, 'getElementKey'> => ({
      getElementKey: (node?: AstNode) => (node ? `${prefix}:${node.$type}` : undefined)
   });
   const registry = makeStubServiceRegistry([
      { languageId: 'dgm', fileExtensions: ['.dgm'], services: { references: { ElementKeyProvider: keyProviderFor('dgm') } } },
      { languageId: 'other', fileExtensions: ['.other'], services: { references: { ElementKeyProvider: keyProviderFor('other') } } }
   ]);
   let walks = 0;
   const resolve = registry.getServicesFor.bind(registry);
   registry.getServicesFor = target => {
      walks += 1;
      return resolve(target);
   };
   const sharedServices = makeNoopSharedServices<ServerSharedServices>({ ServiceRegistry: registry });
   const container = new Container();
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(sharedServices);
   const declared = declaredLanguageUri ? registry.getServicesFor(declaredLanguageUri) : undefined;
   if (declared) {
      // What `bindDiagramLanguage` binds on a real session container: the
      // services of the grammar the diagram module declared.
      container.bind(HydraniumTypes.DiagramLanguage).toConstantValue(declared);
   }
   container.bind(HydraniumGlspIndex).toSelf().inSingletonScope();
   return { index: container.get(HydraniumGlspIndex), ladderWalks: () => walks };
}

/** A root in `uri`'s document with `count` contained children, for the containment walk. */
function makeRootWithChildren(uri: string, count: number): AstNode {
   const root = makeFakeAstNode<AstNode>({ $type: 'Root', $document: { uri: URI.parse(uri) } });
   // Distinct `$type` per child: the stub key providers key on it, so a shared
   // type would collide every child onto one entry and a coverage assertion
   // would pass on a walk that indexed only the first.
   const children = Array.from({ length: count }, (_unused, index) =>
      makeFakeAstNode<AstNode>({ $type: `Child${index}`, $container: root, $containerProperty: 'children', $containerIndex: index })
   );
   (root as unknown as { children: AstNode[] }).children = children;
   return root;
}

describe('HydraniumGlspIndex', () => {
   describe('cross-language keying', () => {
      it('keys a node from a foreign document with that document language key provider', () => {
         const index = createMultiLanguageIndex();
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.dgm'));
         expect(index.findId(makeAstNodeInDoc('file:///m/element.other'))).toBe('other:TestNode');
      });

      it('keys a node from the diagram own document with the diagram language key provider', () => {
         const index = createMultiLanguageIndex();
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.dgm'));
         expect(index.findId(makeAstNodeInDoc('file:///m/other-diagram.dgm'))).toBe('dgm:TestNode');
      });

      it('falls back to the diagram language for a node with no routable document', () => {
         const index = createMultiLanguageIndex();
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.dgm'));
         // No `$document`, so nothing routes it — the diagram's own language answers.
         expect(index.findId(makeFakeAstNode<AstNode>({ $type: 'TestNode' }))).toBe('dgm:TestNode');
      });

      it('returns undefined for an unroutable node before any source root is indexed', () => {
         const index = createMultiLanguageIndex();
         expect(index.findId(makeFakeAstNode<AstNode>({ $type: 'TestNode' }))).toBeUndefined();
      });

      it('takes the diagram language from the indexSourceRoot uri when the root carries no document', () => {
         const index = createMultiLanguageIndex();
         // A synthesised root has no `$document`; the uri the caller declared
         // is then the only signal for the diagram's own language.
         index.indexSourceRoot(makeFakeAstNode<AstNode>({ $type: 'Root' }), 'file:///m/diagram.other');
         expect(index.findId(makeFakeAstNode<AstNode>({ $type: 'TestNode' }))).toBe('other:TestNode');
      });

      it('prefers the root own document over the supplied uri', () => {
         const index = createMultiLanguageIndex();
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.dgm'), 'file:///m/wrong.other');
         expect(index.findId(makeFakeAstNode<AstNode>({ $type: 'TestNode' }))).toBe('dgm:TestNode');
      });

      it('falls back to the declared language before any source root is indexed', () => {
         // GLSP builds every operation handler at InitializeClientSession, so a
         // document-less node can arrive before the first indexSourceRoot. With
         // nothing to answer, createId mints an unstable fallback_<uuid>.
         const index = createMultiLanguageIndex('file:///m/declared.other');
         expect(index.findId(makeFakeAstNode<AstNode>({ $type: 'TestNode' }))).toBe('other:TestNode');
      });

      it('prefers the routed language over the declared one once indexed', () => {
         // The captured one is what the document ACTUALLY routes to; the
         // declared one is the module's claim about it, and the two can drift.
         const index = createMultiLanguageIndex('file:///m/declared.other');
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.dgm'));
         expect(index.findId(makeFakeAstNode<AstNode>({ $type: 'TestNode' }))).toBe('dgm:TestNode');
      });
   });

   describe('indexSourceRoot walk cost', () => {
      it('resolves the key provider once, not once per node', () => {
         // Every node a containment walk yields has `root` as its root node, so
         // a per-node lookup re-derives one known answer N times — a container-
         // chain walk plus Langium's whole lookup ladder, on every diagram open.
         const { index, ladderWalks } = buildMultiLanguageIndex();
         const root = makeRootWithChildren('file:///m/diagram.dgm', 50);
         const before = ladderWalks();
         index.indexSourceRoot(root);
         expect(ladderWalks() - before).toBeLessThanOrEqual(3);
      });

      it('still keys every node in the walk', () => {
         const { index } = buildMultiLanguageIndex();
         const root = makeRootWithChildren('file:///m/diagram.dgm', 3);
         index.indexSourceRoot(root);
         const children = (root as unknown as { children: AstNode[] }).children;
         expect(children.map((_child, position) => index.findSemanticElement(`dgm:Child${position}`))).toEqual(children);
      });
   });

   describe('findId / doFindId hook', () => {
      it('returns the ElementKeyProvider local id when available', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map([[node, 'n1']]));
         expect(index.findId(node)).toBe('n1');
      });

      it('returns undefined for unknown nodes with no fallback', () => {
         const { index } = createIndex(new Map());
         expect(index.findId(makeAstNode())).toBeUndefined();
      });

      it('uses the fallback when no id is found', () => {
         const { index } = createIndex(new Map());
         expect(index.findId(makeAstNode(), () => 'fb')).toBe('fb');
      });

      it('does not call the fallback when an id is found', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map([[node, 'n1']]));
         let fallbackCalls = 0;
         const fallback = (): string => {
            fallbackCalls += 1;
            return 'fb';
         };
         expect(index.findId(node, fallback)).toBe('n1');
         expect(fallbackCalls).toBe(0);
      });
   });

   describe('createId', () => {
      it('uses the assigned id when available', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map([[node, 'n1']]));
         expect(index.createId(node)).toBe('n1');
      });

      it('falls back to a fresh fallback_<uuid> string when none available', () => {
         const { index } = createIndex(new Map());
         expect(index.createId(makeAstNode())).toMatch(/^fallback_[0-9a-f-]{36}$/);
      });
   });

   describe('assertId', () => {
      it('returns the assigned id', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map([[node, 'n1']]));
         expect(index.assertId(node)).toBe('n1');
      });

      it('throws when no id can be derived', () => {
         const { index } = createIndex(new Map());
         expect(() => index.assertId(makeAstNode())).toThrow(/Could not create ID/);
      });

      // The message above reaches a log, a client toast and an adopter's
      // telemetry alike, so quoting the node's source text would expose model
      // content on every one of them. Matching only `Could not create ID`
      // cannot tell the two apart.
      it('names the node type and position without quoting its source text', () => {
         const { index } = createIndex(new Map());
         const node = makeFakeAstNode<AstNode>({
            $type: 'TestNode',
            $cstNode: { text: 'secret model content', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 22 } } }
         });
         let message = '';
         try {
            index.assertId(node);
         } catch (error: unknown) {
            message = error instanceof Error ? error.message : String(error);
         }
         // Asserted before the absence, so a throw that never happened fails
         // here rather than satisfying the negative assertion vacuously.
         expect(message).toContain('TestNode');
         expect(message).toContain('5:3');
         expect(message).not.toContain('secret model content');
      });
   });

   describe('findSemanticElement', () => {
      it('returns the indexed node', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map());
         index.indexSemanticElement('n1', node);
         expect(index.findSemanticElement('n1')).toBe(node);
      });

      it('returns undefined when the guard rejects the node', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map());
         index.indexSemanticElement('n1', node);
         const reject = (item: unknown): item is AstNode => item !== undefined && (item as AstNode).$type === 'OtherType';
         expect(index.findSemanticElement('n1', reject)).toBeUndefined();
      });

      it('returns the narrowed node when the guard accepts', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map());
         index.indexSemanticElement('n1', node);
         const accept = (item: unknown): item is AstNode => item !== undefined && (item as AstNode).$type === 'TestNode';
         expect(index.findSemanticElement('n1', accept)).toBe(node);
      });
   });

   describe('registerElementId / findElementIds', () => {
      // Keyed by the element's stable id, so the represented node must resolve one.
      it('returns the ids registered as representing an element', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map([[node, 'elementStableId']]));
         index.registerElementId(node, 'gmodel-1');
         expect(index.findElementIds(node)).toEqual(['gmodel-1']);
      });

      it('accumulates multiple ids for one element (drawn several times)', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map([[node, 'elementStableId']]));
         index.registerElementId(node, 'nodeA');
         index.registerElementId(node, 'nodeB');
         index.registerElementId(node, 'nodeA'); // idempotent
         expect([...index.findElementIds(node)].sort()).toEqual(['nodeA', 'nodeB']);
      });

      it('ignores an element with no resolvable stable id', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map()); // no stable id for node
         index.registerElementId(node, 'gmodel-1');
         expect(index.findElementIds(node)).toEqual([]);
      });

      it('returns empty for an unregistered or undefined element', () => {
         const { index } = createIndex(new Map([[makeAstNode(), 'someId']]));
         expect(index.findElementIds(makeAstNode())).toEqual([]);
         expect(index.findElementIds(undefined)).toEqual([]);
      });

      it('clears reverse registrations on indexSourceRoot', () => {
         const node = makeAstNode();
         const { index } = createIndex(new Map([[node, 'elementStableId']]));
         index.registerElementId(node, 'gmodel-1');
         index.indexSourceRoot({ $type: 'Root' } as AstNode);
         expect(index.findElementIds(node)).toEqual([]);
      });
   });

   describe('renderedDocumentUris', () => {
      it('seeds the diagram document uri on indexSourceRoot', () => {
         const { index } = createIndex(new Map());
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.a'));
         expect(index.renderedDocumentUris()).toEqual(['file:///m/diagram.a']);
      });

      it('adds the document of an element registered via registerElementId', () => {
         const element = makeAstNodeInDoc('file:///m/element.a');
         const { index } = createIndex(new Map([[element, 'elementStableId']]));
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.a'));
         index.registerElementId(element, 'gmodel-1');
         expect([...index.renderedDocumentUris()].sort()).toEqual(['file:///m/diagram.a', 'file:///m/element.a']);
      });

      it('does not add a document for an element with no resolvable document', () => {
         const element = makeDetachedAstNode();
         const { index } = createIndex(new Map([[element, 'elementStableId']]));
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.a'));
         index.registerElementId(element, 'gmodel-1');
         expect(index.renderedDocumentUris()).toEqual(['file:///m/diagram.a']);
      });

      it('clears the set on the next indexSourceRoot', () => {
         const element = makeAstNodeInDoc('file:///m/element.a');
         const { index } = createIndex(new Map([[element, 'elementStableId']]));
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/diagram.a'));
         index.registerElementId(element, 'gmodel-1');
         index.indexSourceRoot(makeAstNodeInDoc('file:///m/other.a'));
         expect(index.renderedDocumentUris()).toEqual(['file:///m/other.a']);
      });
   });

   describe('indexRoot duplicate-id pruning', () => {
      it('drops a sibling with a colliding id from the tree, keeping the first, and warns', () => {
         const { index, lines } = createIndex(new Map());
         const childA = makeGModelElement('shared');
         const childB = makeGModelElement('shared');
         const root = makeGModelElement('root');
         root.children = [childA, childB];
         expect(() => index.indexRoot(root)).not.toThrow();
         // First occurrence wins; the later duplicate is removed from the submitted tree.
         expect(root.children).toEqual([childA]);
         expect(lines.some(line => line.level === 'warn' && line.message.includes('Dropping duplicate element id'))).toBe(true);
         // Prune runs before doIndex, so the index never sees the duplicate.
         expect(lines.filter(line => line.level === 'error')).toEqual([]);
         expect(index.find('shared')).toBe(childA);
      });

      it('drops a deeply nested duplicate together with its whole subtree', () => {
         const { index } = createIndex(new Map());
         const grandchild = makeGModelElement('grandchild');
         const duplicate = makeGModelElement('shared');
         duplicate.children = [grandchild];
         const original = makeGModelElement('shared');
         const root = makeGModelElement('root');
         root.children = [original, duplicate];
         index.indexRoot(root);
         expect(root.children).toEqual([original]);
         // The dropped duplicate took its subtree with it.
         expect(index.find('grandchild')).toBeUndefined();
      });

      it('drops a child colliding with the root id', () => {
         const { index, lines } = createIndex(new Map());
         const child = makeGModelElement('root');
         const root = makeGModelElement('root');
         root.children = [child];
         index.indexRoot(root);
         expect(root.children).toEqual([]);
         expect(lines.filter(line => line.level === 'warn')).toHaveLength(1);
      });

      it('leaves a duplicate-free tree untouched (same array identity, no warnings)', () => {
         const { index, lines } = createIndex(new Map());
         const childA = makeGModelElement('a');
         const childB = makeGModelElement('b');
         const root = makeGModelElement('root');
         const children = [childA, childB];
         root.children = children;
         index.indexRoot(root);
         expect(root.children).toBe(children);
         expect(root.children).toEqual([childA, childB]);
         expect(lines.filter(line => line.level === 'warn')).toEqual([]);
      });
   });
});
