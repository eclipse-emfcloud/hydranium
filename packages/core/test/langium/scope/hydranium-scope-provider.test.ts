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
import {
   type AstNode,
   type AstNodeDescription,
   type AstReflection,
   EMPTY_SCOPE,
   type LocalSymbols,
   MapScope,
   type ReferenceInfo,
   type Scope,
   type ScopeOptions,
   stream,
   URI
} from '@hydranium/langium';
import { type HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { builtLocalSymbols } from '../../../src/langium/scope/built-local-symbols.js';
import { HydraniumScopeProvider } from '../../../src/langium/scope/hydranium-scope-provider.js';
import { type TieredAstNodeDescription } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeAstNode, makeFakeDescription, makeFakeReflection, makeNoopTracer, makeTestServices } from '../../../src/testing/index.js';

// Logger stub: `.for(name)` returns self, `.trace()` is a no-op, so the
// `Logger.for(component).trace('instantiated')` line every framework service
// runs in its constructor works against the stub without further wiring.
const noopLogger: { for: () => typeof noopLogger; trace: () => void } = {
   for: () => noopLogger,
   trace: () => undefined
};

/**
 * Grammar metadata the stub reflection answers with. `Child` declares a
 * containment list so a test can tell a stub built from reflection apart from a
 * bare `{ $type }` literal; `Orphan` is deliberately absent from the map.
 */
const STUB_TYPE_META: Record<string, { name: string; properties: Record<string, { name: string; defaultValue?: unknown }> }> = {
   Child: { name: 'Child', properties: { items: { name: 'items', defaultValue: [] } } },
   StandIn: { name: 'StandIn', properties: { entries: { name: 'entries', defaultValue: [] } } }
};

/**
 * Minimal stub services tree — enough to construct `HydraniumScopeProvider`
 * without throwing. Tests here cover only the framework-added bridge
 * methods (`referenceContextToInfo`, `resolveReferenceSource`) and the
 * virtual hooks (`resolveSyntheticSource`, `resolveRootElement`,
 * `resolveElementByName`), not the scope chain itself.
 */
function makeStubServices(scopeExtensionService: unknown = {}): HydraniumLanguageServices {
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
      LanguageMetaData: { languageId: 'stub-language', fileExtensions: ['.stub'] },
      references: {
         NameProvider: { getName: () => undefined, getNameNode: () => undefined },
         ScopeExtensionService: scopeExtensionService
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
            LangiumDocuments: {
               getDocument: () => undefined,
               // The new `resolveSyntheticSource` default materialises when
               // nothing is loaded, and records the language it was told to
               // parse under so a test can assert the provider supplied its own.
               createEmptyDocument: (uri: URI, languageId?: string) => ({
                  uri,
                  parseResult: { value: { $type: 'StandInRoot', languageId } }
               })
            },
            DocumentBuilder: documentBuilderStub,
            IndexManager: indexManagerStub,
            ProjectManager: projectManagerStub
         },
         Logger: noopLogger,
         Tracer: makeNoopTracer(),
         AstReflection: {
            getReferenceType: () => 'Fake',
            isSubtype: () => true,
            // The stubs the provider fabricates are built from this metadata, so
            // a type declared here gets its containment arrays the way a parsed
            // node would. Types absent from the map answer no metadata, which is
            // what a real reflection does for a name it does not know.
            getTypeMetaData: (type: string) => STUB_TYPE_META[type]
         } as unknown as AstReflection
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

      it("gives a fabricated stub its grammar's containment lists, not `undefined`", () => {
         // Built as a bare `{ $type, $container… }` literal a stub leaves every
         // declared list `undefined`, where a parsed node of the same type
         // always has `[]` — so an extension or key provider reading one off a
         // stub meets a shape that occurs nowhere else in the tree.
         const root = makeFakeAstNode<AstNode>({ $type: 'Root' });
         class TestProvider extends HydraniumScopeProvider {
            protected override resolveRootElement(): AstNode | undefined {
               return root;
            }
         }
         const provider = new TestProvider(makeStubServices());
         const info = provider.referenceContextToInfo({
            source: ReferenceSource.document('memory://root'),
            syntheticPath: [SyntheticStep.of('children', 'Child')],
            property: 'someRef'
         });
         expect((info.container as AstNode & { items?: unknown[] }).items).toEqual([]);
      });

      it('leaves a type the grammar does not declare carrying only its plumbing', () => {
         // The permissive half: a synthetic path can name a type this grammar
         // has no metadata for, and that must still produce a usable container
         // rather than throwing inside the lookup.
         const root = makeFakeAstNode<AstNode>({ $type: 'Root' });
         class TestProvider extends HydraniumScopeProvider {
            protected override resolveRootElement(): AstNode | undefined {
               return root;
            }
         }
         const provider = new TestProvider(makeStubServices());
         const info = provider.referenceContextToInfo({
            source: ReferenceSource.document('memory://root'),
            syntheticPath: [SyntheticStep.of('children', 'Orphan')],
            property: 'someRef'
         });
         expect(info.container.$type).toBe('Orphan');
         expect(info.container.$container).toBe(root);
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

      it('default resolveSyntheticSource materialises a container when no document is loaded', () => {
         const provider = new HydraniumScopeProvider(makeStubServices());
         const source: SyntheticSource = ReferenceSource.synthetic('memory://missing', 'X');

         const result = provider.resolveReferenceSource(source);

         // A synthetic source names a node that does not exist yet, so abstaining
         // here would answer an empty candidate list — indistinguishable to a
         // client from "nothing matches". The container is the stand-in's root.
         expect(result?.$type).toBe('X');
         expect(result?.$container?.$type).toBe('StandInRoot');
      });

      it('default resolveSyntheticSource parses the stand-in under its OWN language', () => {
         const provider = new HydraniumScopeProvider(makeStubServices());
         const source: SyntheticSource = ReferenceSource.synthetic('memory://a-folder', 'X');

         const result = provider.resolveReferenceSource(source);

         // A folder URI carries no extension, so the provider's own language is
         // the only routing signal left; deriving it from the URI is what fails.
         expect((result?.$container as { languageId?: string } | undefined)?.languageId).toBe('stub-language');
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
            ScopeExtensionService: { getDescriptions: () => [] }
         },
         workspace: {
            AstNodeLocator: { getAstNode: () => undefined },
            AstNodeDescriptionProvider: { createDescription: () => ({}) }
         },
         // `makeTestServices` binds no reflection, but the stubs the provider
         // fabricates are built from one — so supply it here rather than teach
         // the builder to work without one, which production never needs.
         shared: { AstReflection: makeFakeReflection({ Draft: { entries: { defaultValue: [] } } }), ...(shared as object) }
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

   describe('resolveSyntheticSource by default', () => {
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
         // Built from reflection like any other node of this type, so a caller
         // that walks a declared list finds it present and empty.
         expect((result as AstNode & { entries?: unknown[] }).entries).toEqual([]);
      });
   });
});

describe('HydraniumScopeProvider extension tiers', () => {
   /** Answers a fixed project scope, so only the extension layering is under test. */
   class ExtensionLayeringProvider extends HydraniumScopeProvider {
      projectScope: Scope = EMPTY_SCOPE;
      createScopeCalls = 0;

      protected override createGlobalScope(): Scope {
         return this.projectScope;
      }

      protected override createScope(elements: Iterable<AstNodeDescription>, outerScope?: Scope, options?: ScopeOptions): Scope {
         this.createScopeCalls++;
         return super.createScope(elements, outerScope, options);
      }

      globalScope(): Scope {
         const context = { reference: { $refText: 'name' }, container: makeFakeAstNode({ $type: 'Container' }), property: 'ref' };
         return this.getGlobalScope('Fake', context as unknown as ReferenceInfo);
      }
   }

   function extensionDescription(name: string, tier: 'local' | 'universal', type = 'Extension'): TieredAstNodeDescription {
      return makeFakeDescription(name, { type, tier }) as unknown as TieredAstNodeDescription;
   }

   function makeProvider(local: string[], universal: string[]) {
      const asked = { count: 0 };
      const provider = new ExtensionLayeringProvider(
         makeStubServices({
            getDescriptions: () => {
               asked.count++;
               return [
                  {
                     local: local.map(name => extensionDescription(name, 'local')),
                     universal: universal.map(name => extensionDescription(name, 'universal'))
                  }
               ];
            }
         })
      );
      return { provider, asked };
   }

   it('collects the extensions once for both tiers', () => {
      const { provider, asked } = makeProvider(['localSym'], ['stdSym']);
      provider.globalScope();
      expect(asked.count).toBe(1);
   });

   it('puts the local tier above the project scope, built through createScope', () => {
      const { provider } = makeProvider(['collide'], []);
      provider.projectScope = new MapScope([makeFakeDescription('collide', { type: 'Project' })]);
      expect(provider.globalScope().getElement('collide')?.type).toBe('Extension');
      expect(provider.createScopeCalls).toBe(1);
   });

   it('puts the universal tier below the project scope', () => {
      const { provider } = makeProvider([], ['collide', 'stdSym']);
      provider.projectScope = new MapScope([makeFakeDescription('collide', { type: 'Project' })]);
      const scope = provider.globalScope();
      expect(scope.getElement('collide')?.type).toBe('Project');
      expect(scope.getElement('stdSym')?.type).toBe('Extension');
   });

   it('builds the universal tier through createScope as well', () => {
      const { provider } = makeProvider([], ['stdSym']);
      provider.globalScope();
      expect(provider.createScopeCalls).toBe(1);
   });

   it('resolves two universal descriptions of one name to the first, as the local tier does', () => {
      const universal = [extensionDescription('dup', 'universal', 'First'), extensionDescription('dup', 'universal', 'Second')];
      const provider = new ExtensionLayeringProvider(makeStubServices({ getDescriptions: () => [{ local: [], universal }] }));
      expect(provider.globalScope().getElement('dup')?.type).toBe('First');
   });

   it('builds the scope of an extension answering the same descriptions once', () => {
      const answered = [{ local: [extensionDescription('localSym', 'local')], universal: [extensionDescription('stdSym', 'universal')] }];
      const provider = new ExtensionLayeringProvider(makeStubServices({ getDescriptions: () => answered }));
      provider.globalScope();
      const scope = provider.globalScope();
      expect(provider.createScopeCalls).toBe(2);
      expect([scope.getElement('localSym')?.name, scope.getElement('stdSym')?.name]).toEqual(['localSym', 'stdSym']);
   });

   it("resolves a name two extensions answer to the earlier extension's, in both tiers", () => {
      const provider = new ExtensionLayeringProvider(
         makeStubServices({
            getDescriptions: () => [
               { local: [extensionDescription('dup', 'local', 'First')], universal: [extensionDescription('std', 'universal', 'First')] },
               { local: [extensionDescription('dup', 'local', 'Second')], universal: [extensionDescription('std', 'universal', 'Second')] }
            ]
         })
      );
      const scope = provider.globalScope();
      expect([scope.getElement('dup')?.type, scope.getElement('std')?.type]).toEqual(['First', 'First']);
   });

   it('returns the project scope itself when no extension contributes', () => {
      const { provider } = makeProvider([], []);
      provider.projectScope = new MapScope([makeFakeDescription('only', { type: 'Project' })]);
      expect(provider.globalScope()).toBe(provider.projectScope);
   });
});

describe('HydraniumScopeProvider document-local scope', () => {
   /** Answers an empty project scope, so only the document-local tier is under test. */
   class LocalScopeProvider extends HydraniumScopeProvider {
      protected override createGlobalScope(): Scope {
         return EMPTY_SCOPE;
      }
   }

   /** `declared` per container, counting how often a container's symbols are streamed. */
   function makeLocalSymbols(declared: Map<AstNode, AstNodeDescription[]>): LocalSymbols & { streamed: number } {
      return {
         streamed: 0,
         has: node => declared.has(node),
         getStream(node) {
            this.streamed++;
            return stream(declared.get(node) ?? []);
         }
      };
   }

   function makeTree(): { root: AstNode & { $document: { localSymbols?: LocalSymbols } }; child: AstNode } {
      const root = makeFakeAstNode<AstNode & { $document: { localSymbols?: LocalSymbols } }>({ $type: 'Root', $document: {} });
      const child = makeFakeAstNode({ $type: 'Child', $container: root });
      return { root, child };
   }

   function referenceIn(container: AstNode, property = 'ref'): ReferenceInfo {
      return { reference: { $refText: 'x' }, container, property } as unknown as ReferenceInfo;
   }

   const provider = new LocalScopeProvider(makeStubServices({ getDescriptions: () => [] }));

   /** A reference through `one` targets `TypeOne`, any other `TypeTwo`; each type is a subtype of itself only. */
   function makeTypedProvider(): LocalScopeProvider {
      const services = makeStubServices({ getDescriptions: () => [] });
      const reflection = {
         ...services.shared.AstReflection,
         getReferenceType: (context: ReferenceInfo) => (context.property === 'one' ? 'TypeOne' : 'TypeTwo'),
         isSubtype: (subtype: string, supertype: string) => subtype === supertype
      } as unknown as AstReflection;
      return new LocalScopeProvider({
         ...services,
         shared: { ...services.shared, AstReflection: reflection }
      } as HydraniumLanguageServices);
   }

   it("builds a container's local scope once for every reference into it, and again once the build recomputes the symbols", () => {
      const { root, child } = makeTree();
      const symbols = makeLocalSymbols(new Map([[root, [makeFakeDescription('a', { type: 'Fake' })]]]));
      root.$document.localSymbols = symbols;

      expect(provider.getScope(referenceIn(child)).getElement('a')?.name).toBe('a');
      expect(provider.getScope(referenceIn(child)).getElement('a')?.name).toBe('a');
      expect(symbols.streamed).toBe(1);

      const rebuilt = makeLocalSymbols(new Map([[root, [makeFakeDescription('b', { type: 'Fake' })]]]));
      root.$document.localSymbols = rebuilt;
      const scope = provider.getScope(referenceIn(child));
      expect([scope.getElement('a'), scope.getElement('b')?.name]).toEqual([undefined, 'b']);
      expect(rebuilt.streamed).toBe(1);
   });

   it('keeps a separate local scope for each reference type reaching a container', () => {
      const typed = makeTypedProvider();
      const { root, child } = makeTree();
      root.$document.localSymbols = makeLocalSymbols(
         new Map([[root, [makeFakeDescription('x', { type: 'TypeOne' }), makeFakeDescription('x', { type: 'TypeTwo' })]]])
      );

      expect(typed.getScope(referenceIn(child, 'one')).getElement('x')?.type).toBe('TypeOne');
      expect(typed.getScope(referenceIn(child, 'two')).getElement('x')?.type).toBe('TypeTwo');
   });

   it("lets an inner container's symbols shadow an outer container's of the same name", () => {
      const { root, child } = makeTree();
      root.$document.localSymbols = makeLocalSymbols(
         new Map([
            [root, [makeFakeDescription('x', { type: 'Outer' }), makeFakeDescription('onlyOuter', { type: 'Outer' })]],
            [child, [makeFakeDescription('x', { type: 'Inner' })]]
         ])
      );

      const inChild = provider.getScope(referenceIn(child));
      expect([inChild.getElement('x')?.type, inChild.getElement('onlyOuter')?.type]).toEqual(['Inner', 'Outer']);
      expect(provider.getScope(referenceIn(root)).getElement('x')?.type).toBe('Outer');
   });

   /** A root declaring `name`, its document built to it, its symbols recorded as the build pipeline does when `recorded`. */
   function makeBuiltTree(
      name: string,
      recorded: boolean
   ): { root: AstNode; child: AstNode; document: { parseResult: { value: AstNode }; localSymbols?: LocalSymbols } } {
      const document = {} as { parseResult: { value: AstNode }; localSymbols?: LocalSymbols };
      const root = makeFakeAstNode({ $type: 'Root', $document: document });
      const child = makeFakeAstNode({ $type: 'Child', $container: root });
      document.parseResult = { value: root };
      document.localSymbols = makeLocalSymbols(new Map([[root, [makeFakeDescription(name, { type: 'Fake' })]]]));
      if (recorded) {
         builtLocalSymbols.set(root, document.localSymbols);
      }
      return { root, child, document };
   }

   it('answers a node of a root its document replaced from the symbols recorded for that root', () => {
      const { child, document } = makeBuiltTree('old', true);
      const rebuilt = makeFakeAstNode({ $type: 'Root', $document: document });
      document.parseResult = { value: rebuilt };
      document.localSymbols = makeLocalSymbols(new Map([[rebuilt, [makeFakeDescription('new', { type: 'Fake' })]]]));

      expect(provider.getScope(referenceIn(child)).getElement('old')?.name).toBe('old');
   });

   it('answers from the recorded symbols while a rebuild has cleared the document', () => {
      const { child, document } = makeBuiltTree('kept', true);
      document.localSymbols = undefined;

      expect(provider.getScope(referenceIn(child)).getElement('kept')?.name).toBe('kept');
   });

   it("prefers the document's symbols for its current root over the recorded ones", () => {
      const { root, child, document } = makeBuiltTree('recorded', true);
      document.localSymbols = makeLocalSymbols(new Map([[root, [makeFakeDescription('assigned', { type: 'Fake' })]]]));

      const scope = provider.getScope(referenceIn(child));
      expect([scope.getElement('assigned')?.name, scope.getElement('recorded')]).toEqual(['assigned', undefined]);
   });

   it("falls back to the document's symbols for a root no computation recorded", () => {
      const { child } = makeBuiltTree('unrecorded', false);

      expect(provider.getScope(referenceIn(child)).getElement('unrecorded')?.name).toBe('unrecorded');
   });
});
