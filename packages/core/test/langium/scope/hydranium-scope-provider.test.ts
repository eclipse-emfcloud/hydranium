/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import {
   Disposable,
   type ReferenceContext,
   ReferenceSource,
   type ElementSource,
   type DocumentSource,
   SyntheticStep,
   type SyntheticSource
} from '@hydranium/protocol';
import { type AstNode, type AstReflection, MapScope, type Scope, URI } from '@hydranium/langium';
import { type HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { HydraniumScopeProvider } from '../../../src/langium/scope/hydranium-scope-provider.js';
import { type TieredAstNodeDescription } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeAstNode, makeFakeDescription, makeNoopTracer, makeTestServices } from '../../../src/testing/index.js';

// Logger stub: `.for(name)` returns self, `.trace()` is a no-op, so the
// `Logger.for(component).trace('instantiated')` line every framework service
// runs in its constructor works against the stub without further wiring.
const noopLogger: { for: () => typeof noopLogger; trace: () => void } = {
   for: () => noopLogger,
   trace: () => undefined
};

/**
 * Minimal stub services tree — enough to construct `HydraniumScopeProvider`
 * without throwing. Tests here cover only the framework-added bridge
 * methods (`referenceContextToInfo`, `resolveReferenceSource`) and the
 * virtual hooks (`resolveSyntheticSource`, `resolveRootElement`,
 * `resolveElementByName`), not the scope chain itself.
 */
function makeStubServices(): HydraniumLanguageServices {
   const documentBuilderStub = {
      onUpdate: () => Disposable.EMPTY,
      onBuildPhase: () => Disposable.EMPTY
   };
   const indexManagerStub = { allElements: () => ({ toArray: () => [] }) };
   const projectManagerStub = {
      getProject: () => undefined,
      isSingleProject: () => true,
      getVisibleProjects: () => []
   };
   return {
      references: {
         NameProvider: { getName: () => undefined, getNameNode: () => undefined },
         ScopeExtensionService: {}
      },
      workspace: {
         AstNodeDescriptionProvider: {
            createDescription: () => ({ name: 'x', type: 'Fake', documentUri: URI.parse('memory://x'), path: '/' })
         },
         AstNodeLocator: { getAstNode: () => undefined },
         IndexManager: indexManagerStub
      },
      shared: {
         workspace: {
            LangiumDocuments: { getDocument: () => undefined },
            DocumentBuilder: documentBuilderStub,
            IndexManager: indexManagerStub,
            ProjectManager: projectManagerStub
         },
         Logger: noopLogger,
         Tracer: makeNoopTracer(),
         AstReflection: { getReferenceType: () => 'Fake', isSubtype: () => true } as unknown as AstReflection
      }
   } as unknown as HydraniumLanguageServices;
}

describe('HydraniumScopeProvider', () => {
   describe('referenceContextToInfo', () => {
      it('throws when the source cannot be resolved', () => {
         const provider = new HydraniumScopeProvider(makeStubServices());
         const ctx: ReferenceContext = {
            source: { type: 'Unknown' } as unknown as ReferenceSource,
            property: 'someRef'
         };
         expect(() => provider.referenceContextToInfo(ctx)).toThrow(/Invalid reference source/);
      });

      it('builds a synthetic-element chain on top of a resolved root source', () => {
         const root = makeFakeAstNode<AstNode>({ $type: 'Root' });
         class TestProvider extends HydraniumScopeProvider {
            protected override resolveRootElement(): AstNode | undefined {
               return root;
            }
         }
         const provider = new TestProvider(makeStubServices());
         const ctx: ReferenceContext = {
            source: ReferenceSource.document('memory://root'),
            syntheticPath: [SyntheticStep.of('children', 'Child')],
            property: 'someRef'
         };
         const info = provider.referenceContextToInfo(ctx);
         expect(info.container.$type).toBe('Child');
         expect(info.container.$container).toBe(root);
         expect(info.container.$containerProperty).toBe('children');
         expect(info.property).toBe('someRef');
      });

      it("carries a step's index onto the stub as $containerIndex", () => {
         const root = makeFakeAstNode<AstNode>({ $type: 'Root' });
         class TestProvider extends HydraniumScopeProvider {
            protected override resolveRootElement(): AstNode | undefined {
               return root;
            }
         }
         const provider = new TestProvider(makeStubServices());
         const info = provider.referenceContextToInfo({
            source: ReferenceSource.document('memory://root'),
            syntheticPath: [SyntheticStep.of('children', 'Child', 2)],
            property: 'someRef'
         });
         expect(info.container.$containerIndex).toBe(2);
      });
   });

   describe('resolveReferenceSource over a whole context', () => {
      /** A root whose `only` slot holds one node and whose `many` slot holds two. */
      function makeTreeProvider(): HydraniumScopeProvider {
         const leaf = makeFakeAstNode<AstNode>({ $type: 'Leaf' });
         const first = makeFakeAstNode<AstNode>({ $type: 'Item' });
         const second = makeFakeAstNode<AstNode>({ $type: 'Item' });
         const root = makeFakeAstNode<AstNode>({ $type: 'Root', only: leaf, many: [first, second] });
         class TestProvider extends HydraniumScopeProvider {
            protected override resolveRootElement(): AstNode | undefined {
               return root;
            }
         }
         return new TestProvider(makeStubServices());
      }

      const contextFor = (steps: SyntheticStep[]): ReferenceContext => ({
         source: ReferenceSource.document('memory://root'),
         syntheticPath: steps,
         property: 'someRef'
      });

      it('descends into a single-valued slot and answers the real child', () => {
         const resolved = makeTreeProvider().resolveReferenceSource(contextFor([SyntheticStep.of('only', 'Leaf')]));
         expect(resolved?.$type).toBe('Leaf');
      });

      it('selects the addressed element of an array slot', () => {
         const provider = makeTreeProvider();
         const first = provider.resolveReferenceSource(contextFor([SyntheticStep.of('many', 'Item', 0)]));
         const second = provider.resolveReferenceSource(contextFor([SyntheticStep.of('many', 'Item', 1)]));
         expect(first?.$type).toBe('Item');
         expect(second?.$type).toBe('Item');
         expect(first).not.toBe(second);
      });

      it('stops at an array slot addressed without an index, rather than descending into the array', () => {
         const resolved = makeTreeProvider().resolveReferenceSource(contextFor([SyntheticStep.of('many', 'Item')]));
         expect(resolved).toBeUndefined();
      });

      it('answers undefined for an out-of-range index and for a slot the node does not have', () => {
         const provider = makeTreeProvider();
         expect(provider.resolveReferenceSource(contextFor([SyntheticStep.of('many', 'Item', 7)]))).toBeUndefined();
         expect(provider.resolveReferenceSource(contextFor([SyntheticStep.of('absent', 'Item')]))).toBeUndefined();
      });

      it('resolves the anchor itself when the context carries no path', () => {
         const resolved = makeTreeProvider().resolveReferenceSource(contextFor([]));
         expect(resolved?.$type).toBe('Root');
      });
   });

   describe('source resolution hooks', () => {
      it('routes SyntheticSource through resolveSyntheticSource', () => {
         const sentinel = makeFakeAstNode<AstNode>({ $type: 'Sentinel' });
         class TestProvider extends HydraniumScopeProvider {
            protected override resolveSyntheticSource(): AstNode | undefined {
               return sentinel;
            }
         }
         const provider = new TestProvider(makeStubServices());
         const source: SyntheticSource = ReferenceSource.synthetic('memory://x', 'X');
         const result = provider.resolveReferenceSource(source);
         expect(result).toBe(sentinel);
      });

      it('routes ElementSource through resolveElementByName', () => {
         const sentinel = makeFakeAstNode<AstNode>({ $type: 'Global' });
         let receivedName: string | undefined;
         let receivedType: string | undefined;
         class TestProvider extends HydraniumScopeProvider {
            protected override resolveElementByName(name: string, type?: string): AstNode | undefined {
               receivedName = name;
               receivedType = type;
               return sentinel;
            }
         }
         const provider = new TestProvider(makeStubServices());
         const source: ElementSource = ReferenceSource.element('ns.Element', 'TypeOne');
         const result = provider.resolveReferenceSource(source);
         expect(result).toBe(sentinel);
         expect(receivedName).toBe('ns.Element');
         expect(receivedType).toBe('TypeOne');
      });

      it('default resolveElementByName returns undefined (consumers opt in)', () => {
         const provider = new HydraniumScopeProvider(makeStubServices());
         const source: ElementSource = ReferenceSource.element('x', 'Y');
         const result = provider.resolveReferenceSource(source);
         expect(result).toBeUndefined();
      });

      it('default resolveSyntheticSource returns undefined when document is not loaded', () => {
         const provider = new HydraniumScopeProvider(makeStubServices());
         const source: SyntheticSource = ReferenceSource.synthetic('memory://missing', 'X');
         const result = provider.resolveReferenceSource(source);
         expect(result).toBeUndefined();
      });
   });

   describe('SyntheticStep factories', () => {
      it('of(containerProperty, type) constructs a single step', () => {
         expect(SyntheticStep.of('children', 'Child')).toEqual({ containerProperty: 'children', type: 'Child' } as never);
      });

      it('chain(...) maps tuples to a SyntheticStep[] in order', () => {
         const path = SyntheticStep.chain(['target', 'TypeOne'], ['members', 'TypeTwo'], ['sources', 'SharedType']);
         expect(path).toEqual([
            { containerProperty: 'target', type: 'TypeOne' },
            { containerProperty: 'members', type: 'TypeTwo' },
            { containerProperty: 'sources', type: 'SharedType' }
         ]);
      });

      it('chain() with no arguments returns an empty array', () => {
         expect(SyntheticStep.chain()).toEqual([]);
      });
   });

   describe('ReferenceSource factories', () => {
      it('document(uri) constructs a DocumentSource', () => {
         const source = ReferenceSource.document('memory://foo');
         expect(source).toEqual({ uri: 'memory://foo' } satisfies DocumentSource);
      });

      it('element(name, type?) constructs an ElementSource', () => {
         expect(ReferenceSource.element('ns.Element')).toEqual({ name: 'ns.Element', type: undefined } satisfies ElementSource);
         expect(ReferenceSource.element('ns.Element', 'TypeOne')).toEqual({ name: 'ns.Element', type: 'TypeOne' } satisfies ElementSource);
      });

      it('synthetic(uri, type) constructs a SyntheticSource', () => {
         expect(ReferenceSource.synthetic('memory://draft', 'Node')).toEqual({
            uri: 'memory://draft',
            type: 'Node'
         } satisfies SyntheticSource);
      });
   });

   // ============================================================
   // getProjectScope early-exit guards + tier-walk array seeding
   // ============================================================

   interface FakeRoot extends AstNode {
      readonly $type: 'FakeRoot';
      readonly name: string;
   }

   function makeLanguageServices(shared: unknown): HydraniumLanguageServices {
      return {
         references: {
            NameProvider: { getName: () => undefined, getNameNode: () => undefined, nameSeparator: '.' },
            ScopeExtensionService: {
               getLocalExtensionScope: (_t: string, _c: AstNode, outer: Scope) => outer,
               getUniversalExtensionScope: (_t: string, _c: AstNode, outer: Scope) => outer
            }
         },
         workspace: {
            AstNodeLocator: { getAstNode: () => undefined },
            AstNodeDescriptionProvider: { createDescription: () => ({}) }
         },
         shared
      } as unknown as HydraniumLanguageServices;
   }

   function tiered(name: string, uri: string, projectId: string): TieredAstNodeDescription {
      return makeFakeDescription(name, {
         documentUri: URI.parse(uri),
         type: 'FakeRoot',
         path: '',
         tier: 'project',
         projectId
      }) as unknown as TieredAstNodeDescription;
   }

   function names(scope: Scope): string[] {
      return scope
         .getAllElements()
         .map(d => d.name)
         .toArray()
         .sort();
   }

   const REF_TYPE = 'FakeRoot';

   describe('getProjectScope early-exit guards', () => {
      it('returns the input scope unchanged when the source URI has no owning project (multi-project workspace)', () => {
         // Two projects exist, so the isSingleProject fast-path does NOT fire — the only
         // reason the foreign 'A.Element' survives is the unowned-source early return.
         // Without that return the filter runs with sourceProjectId undefined, whose
         // visibility closure is empty, and hides it.
         const bundle = makeTestServices<FakeRoot>({
            seedProjects: [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ]
         });
         bundle.projectManager.ownUri('file:///workspace/projA/E.fake', 'A');
         const provider = new HydraniumScopeProvider(makeLanguageServices(bundle.services));
         const global = new MapScope([tiered('A.Element', 'file:///workspace/projA/E.fake', 'A')]);
         // Source URI is NOT owned by any project.
         const result = provider.getProjectScope(URI.parse('file:///workspace/unowned/S.fake'), global, REF_TYPE);
         expect(names(result)).toEqual(['A.Element']);
      });

      it('skips the project filter in a single-project workspace (fast-path keeps foreign descriptions)', () => {
         // Exactly one project ('single') exists, so the fast-path returns the global scope
         // unchanged — including a description tagged for a different project 'other'.
         // Without the fast-path the filter runs ('other' !== 'single', not visible) and
         // hides it, which is what makes this discriminating.
         const bundle = makeTestServices<FakeRoot>({ seedProjects: [{ id: 'single', referenceName: 'single' }] });
         bundle.projectManager.ownUri('file:///workspace/single/S.fake', 'single');
         const provider = new HydraniumScopeProvider(makeLanguageServices(bundle.services));
         const foreign = new MapScope([tiered('foreign.Element', 'file:///workspace/other/E.fake', 'other')]);
         const result = provider.getProjectScope(URI.parse('file:///workspace/single/S.fake'), foreign, REF_TYPE);
         expect(names(result)).toEqual(['foreign.Element']);
      });
   });

   describe('tier-walk bucket seeding', () => {
      it('produces an empty scope when every global description buckets as hidden', () => {
         // The three per-tier bucket arrays are filled ONLY by `bucketFor`'s
         // verdict, never seeded from the walk. A global scope whose every entry
         // is hidden is what makes that discriminating: seeding any bucket with
         // the walked descriptions leaks 'B.Element' straight through into the
         // chained scope, while an EMPTY global scope leaves the two shapes
         // indistinguishable.
         const bundle = makeTestServices<FakeRoot>({
            seedProjects: [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ]
         });
         bundle.projectManager.ownUri('file:///workspace/projA/S.fake', 'A');
         const provider = new HydraniumScopeProvider(makeLanguageServices(bundle.services));
         // Project-tier and owned by 'B', which is not the source's project and
         // is not in its (empty) dependency closure.
         const global = new MapScope([tiered('B.Element', 'file:///workspace/projB/E.fake', 'B')]);
         const result = provider.getProjectScope(URI.parse('file:///workspace/projA/S.fake'), global, REF_TYPE);
         expect(names(result)).toEqual([]);
      });
   });

   // ============================================================
   // Source-resolution switch + default hooks
   // ============================================================

   describe('resolveReferenceSource switch', () => {
      it('returns undefined for a source that matches none of the synthetic/root/identified guards', () => {
         // An unrecognised source must fall through to the final `return undefined`, NOT
         // be routed to resolveElementByName. The spy records whether the element branch
         // was taken, so a too-permissive guard shows up as a call count rather than as
         // an equivalent-looking undefined.
         let identifiedCalls = 0;
         class SpyProvider extends HydraniumScopeProvider {
            protected override resolveElementByName(): AstNode | undefined {
               identifiedCalls++;
               return makeFakeAstNode<AstNode>({ $type: 'Spurious' });
            }
         }
         const provider = new SpyProvider(makeStubServices());
         const bogus = { somethingElse: true } as unknown as ReferenceSource;
         const result = provider.resolveReferenceSource(bogus);
         expect(result).toBeUndefined();
         expect(identifiedCalls).toBe(0);
      });
   });

   describe('resolveSyntheticSource (default)', () => {
      it('builds a transient stub rooted at the loaded document parse root', () => {
         // With the document loaded the default must return a node carrying the requested
         // $type and the parse root as $container — both halves asserted, so neither the
         // document guard nor the stub's shape can regress unnoticed.
         const docUri = 'memory://loaded';
         const root = makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'r' });
         const bundle = makeTestServices<FakeRoot>({ seedDocuments: [{ uri: docUri, root }] });
         const provider = new HydraniumScopeProvider(makeLanguageServices(bundle.services));
         const source: SyntheticSource = ReferenceSource.synthetic(docUri, 'Draft');
         const result = provider.resolveReferenceSource(source);
         expect(result).toBeDefined();
         expect(result?.$type).toBe('Draft');
         expect(result?.$container).toBe(root);
      });
   });
});
