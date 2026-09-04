/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type AstNodeDescription, type ReferenceInfo, stream, type Stream, URI } from '@hydranium/langium';
import { Disposable } from '@hydranium/protocol';
import { type ServerLanguageServices } from '../../../src/langium/language-module.js';
import { type LabelProvider } from '../../../src/langium/labeling/label-provider.js';
import {
   type CandidateScope,
   DefaultReferenceCandidateProvider,
   type ScopedReferenceInfo
} from '../../../src/langium/scope/reference-candidate-provider.js';
import { type HydraniumScopeProvider } from '../../../src/langium/scope/hydranium-scope-provider.js';
import { DefaultNameProvider } from '../../../src/langium/naming/name-provider.js';
import { makeFakeAstNode, makeFakeDescription, makeNoopTracer, makeStubServiceRegistry } from '../../../src/testing/index.js';

const noopLogger: { for: () => typeof noopLogger; trace: () => void } = {
   for: () => noopLogger,
   trace: () => undefined
};

/**
 * Minimal stub services tree wiring the provider's three reads:
 * `services.shared.workspace.ProjectManager` (project id for the
 * source), `services.references.ScopeProvider` (outer scope source), and
 * `services.references.LabelProvider` (display-name in `buildCandidate`).
 * Tests vary `projectId` per case to exercise the canonical filter.
 */
function makeServicesStub(
   scopeProvider: HydraniumScopeProvider,
   labelProvider: LabelProvider,
   projectId: string | undefined = undefined
): ServerLanguageServices {
   return {
      references: {
         ScopeProvider: scopeProvider,
         LabelProvider: labelProvider
      },
      shared: {
         workspace: {
            ProjectManager: { getProject: () => (projectId ? { id: projectId } : undefined) },
            // `DefaultNameProvider` subscribes here to evict its per-document cache.
            DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
         },
         Logger: noopLogger,
         Tracer: makeNoopTracer()
      }
   } as unknown as ServerLanguageServices;
}

function makeScopeProviderStub(elements: AstNodeDescription[]): HydraniumScopeProvider {
   const scope = { getAllElements: () => stream(elements), getElement: () => undefined };
   const fakeNode = makeFakeAstNode<AstNode>({ $type: 'Source' });
   (fakeNode as unknown as { $document: { uri: URI } }).$document = { uri: URI.parse('memory://test') };
   return {
      getScope: () => scope,
      referenceContextToInfo: () => ({ reference: { $refText: '', ref: undefined }, container: fakeNode, property: 'ref' }),
      sortText: (d: AstNodeDescription) => d.name
   } as unknown as HydraniumScopeProvider;
}

function makeLabelProviderStub(displayNames: Map<AstNode | undefined, string | undefined> = new Map()): LabelProvider {
   return {
      getLabel: (node: AstNode | undefined) => displayNames.get(node)
   } as unknown as LabelProvider;
}

/** Exposes the protected `nameProviderFor` seam a subclass filter would use. */
class ExposedProvider extends DefaultReferenceCandidateProvider {
   nameFor(target: AstNode): string | undefined {
      return this.nameProviderFor(target).getDocumentQualifiedName(target);
   }
}

function makeReferenceInfo(): ReferenceInfo {
   const container = makeFakeAstNode<AstNode>({ $type: 'Source' });
   (container as unknown as { $document: { uri: URI } }).$document = { uri: URI.parse('memory://test') };
   return { reference: { $refText: '', ref: undefined }, container, property: 'ref' };
}

describe('DefaultReferenceCandidateProvider', () => {
   describe('nameProviderFor', () => {
      /**
       * Two languages whose naming config genuinely differs: `.a` joins
       * segments with `.`, `.b` with `::`. A candidate scope legitimately
       * spans both — cross-language references resolve through the global
       * index — so a subclass filtering candidates by qualified name is handed
       * foreign-language target nodes.
       */
      function crossGrammarProvider(): { provider: ExposedProvider; targetInOtherGrammar: AstNode } {
         const services = makeServicesStub(makeScopeProviderStub([]), makeLabelProviderStub());
         const sourceNames = new DefaultNameProvider(services);
         const langBServices = { ...services, references: {} } as unknown as ServerLanguageServices;
         const langBNames = new DefaultNameProvider(langBServices, { nameSeparator: '::' });
         (langBServices.references as unknown as { NameProvider: DefaultNameProvider }).NameProvider = langBNames;
         (services.references as unknown as { NameProvider: DefaultNameProvider }).NameProvider = sourceNames;

         const registry = makeStubServiceRegistry([
            { languageId: 'langA', fileExtensions: ['.a'], services: { references: services.references } },
            { languageId: 'langB', fileExtensions: ['.b'], services: { references: langBServices.references } }
         ]);
         (services.shared as unknown as { ServiceRegistry: unknown }).ServiceRegistry = registry;

         const langBRoot = makeFakeAstNode<AstNode>({ $type: 'BaseType', name: 'Q' } as never);
         Object.assign(langBRoot, { $document: { uri: URI.parse('file:///w/other.b') } });
         const target = makeFakeAstNode<AstNode>({ $type: 'TypeOne', $container: langBRoot, name: 'T' } as never);
         return { provider: new ExposedProvider(services), targetInOtherGrammar: target };
      }

      it("resolves a foreign-language target's name with the TARGET language's provider", () => {
         // With the captured source provider this reads `Q.T` — a name no
         // `.b` element is indexed under, so a self-reference filter that
         // compares against it never matches and silently stops filtering.
         const { provider, targetInOtherGrammar } = crossGrammarProvider();
         expect(provider.nameFor(targetInOtherGrammar)).toBe('Q::T');
      });

      it('falls back to the source provider for a target that routes nowhere', () => {
         const { provider } = crossGrammarProvider();
         const detachedRoot = makeFakeAstNode<AstNode>({ $type: 'BaseType', name: 'Q' } as never);
         const detached = makeFakeAstNode<AstNode>({ $type: 'TypeOne', $container: detachedRoot, name: 'T' } as never);
         expect(provider.nameFor(detached)).toBe('Q.T');
      });
   });

   describe('getCandidateScope', () => {
      it('dedupes descriptions by name', () => {
         const descriptions = [makeFakeDescription('A'), makeFakeDescription('A'), makeFakeDescription('B')];
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub())
         );
         const scope = provider.getCandidateScope(makeReferenceInfo());
         const names = scope.elementScope
            .getAllElements()
            .map(d => d.name)
            .toArray();
         expect(names).toEqual(['A', 'B']);
      });

      it('sorts descriptions via scopeProvider.sortText', () => {
         const descriptions = [makeFakeDescription('B'), makeFakeDescription('A'), makeFakeDescription('C')];
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub())
         );
         const scope = provider.getCandidateScope(makeReferenceInfo());
         const names = scope.elementScope
            .getAllElements()
            .map(d => d.name)
            .toArray();
         expect(names).toEqual(['A', 'B', 'C']);
      });

      it('uses the ReferenceInfo directly when ctx already carries `reference` (does not route through referenceContextToInfo)', () => {
         // Distinguishes the `'reference' in ctx` branch: a ReferenceInfo input
         // must be passed straight to scopedReferenceInfo, never converted via
         // referenceContextToInfo. Make the converter throw so the wrong branch
         // is observable as a failure rather than a silent equivalent result.
         const scopeProvider = makeScopeProviderStub([makeFakeDescription('A')]);
         (scopeProvider as unknown as { referenceContextToInfo: () => never }).referenceContextToInfo = () => {
            throw new Error('referenceContextToInfo must not be called for a ReferenceInfo input');
         };
         const provider = new DefaultReferenceCandidateProvider(makeServicesStub(scopeProvider, makeLabelProviderStub()));
         const scope = provider.getCandidateScope(makeReferenceInfo());
         expect(
            scope.elementScope
               .getAllElements()
               .map(d => d.name)
               .toArray()
         ).toEqual(['A']);
      });

      it('routes a ReferenceContext through referenceContextToInfo when `reference` is absent', () => {
         // Complementary branch: a context without `reference` must be converted.
         let converted = false;
         const scopeProvider = makeScopeProviderStub([makeFakeDescription('A')]);
         const fakeNode = makeFakeAstNode<AstNode>({ $type: 'Source' });
         (fakeNode as unknown as { $document: { uri: URI } }).$document = { uri: URI.parse('memory://test') };
         (scopeProvider as unknown as { referenceContextToInfo: () => ReferenceInfo }).referenceContextToInfo = () => {
            converted = true;
            return { reference: { $refText: '', ref: undefined }, container: fakeNode, property: 'ref' };
         };
         const provider = new DefaultReferenceCandidateProvider(makeServicesStub(scopeProvider, makeLabelProviderStub()));
         provider.getCandidateScope({ source: { uri: 'memory://test' }, property: 'ref' });
         expect(converted).toBe(true);
      });

      it('scopedReferenceInfo enriches the reference with document + projectId fields', () => {
         // The returned source must spread the original info AND carry document +
         // resolved projectId — asserting all four fields, so dropping either the
         // spread or one of the added fields is observable.
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub([makeFakeDescription('A')]), makeLabelProviderStub(), 'myProject')
         );
         const scope = provider.getCandidateScope(makeReferenceInfo());
         expect(scope.source.projectId).toBe('myProject');
         expect(scope.source.document).toBeDefined();
         expect(scope.source.document.uri.toString()).toBe('memory://test');
         expect(scope.source.property).toBe('ref');
         expect(scope.source.reference).toBeDefined();
      });

      it('scopedReferenceInfo leaves projectId undefined when no project resolves', () => {
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub([makeFakeDescription('A')]), makeLabelProviderStub())
         );
         const scope = provider.getCandidateScope(makeReferenceInfo());
         expect(scope.source.projectId).toBeUndefined();
         expect(scope.source.document.uri.toString()).toBe('memory://test');
      });

      it('canonical filter collapses tier-siblings to the most-specific tier', () => {
         // One node emitted at two tiers (same path) — the project-tier short
         // name is more specific than the public-tier qualified name.
         const descriptions = [
            makeFakeDescription('myDM.Foo', { tier: 'public', projectId: 'myDM', path: '/Foo' }),
            makeFakeDescription('Foo', { tier: 'project', projectId: 'myDM', path: '/Foo' })
         ];
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub(), 'myDM')
         );
         const scope = provider.getCandidateScope(makeReferenceInfo());
         const names = scope.elementScope
            .getAllElements()
            .map(d => d.name)
            .toArray();
         expect(names).toEqual(['Foo']);
      });

      it('applyCanonicalFilter override can keep every tier-sibling', () => {
         const descriptions = [
            makeFakeDescription('myDM.Foo', { tier: 'public', projectId: 'myDM', path: '/Foo' }),
            makeFakeDescription('Foo', { tier: 'project', projectId: 'myDM', path: '/Foo' })
         ];
         class RawProvider extends DefaultReferenceCandidateProvider {
            protected override applyCanonicalFilter<T extends AstNodeDescription>(candidates: Stream<T>): Stream<T> {
               return candidates;
            }
         }
         const provider = new RawProvider(makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub(), 'myDM'));
         const scope = provider.getCandidateScope(makeReferenceInfo());
         const names = scope.elementScope
            .getAllElements()
            .map(d => d.name)
            .toArray();
         expect(names.sort()).toEqual(['Foo', 'myDM.Foo']);
      });
   });

   describe('find', () => {
      it('returns candidates with label === value when no display name', () => {
         const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne' });
         const descriptions = [makeFakeDescription('Foo', { node })];
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub())
         );
         const candidates = provider.find({
            source: { uri: 'memory://test' },
            property: 'ref'
         });
         expect(candidates).toEqual([{ uri: 'memory://test', type: 'Fake', label: 'Foo', value: 'Foo' }]);
      });

      it('uses getLabel as label when distinct from description name', () => {
         const node = makeFakeAstNode<AstNode>({ $type: 'TypeTwo' });
         const descriptions = [makeFakeDescription('element_id', { node })];
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub(new Map([[node, 'ns.Element']])))
         );
         const candidates = provider.find({
            source: { uri: 'memory://test' },
            property: 'ref'
         });
         expect(candidates[0]).toEqual({ uri: 'memory://test', type: 'Fake', label: 'ns.Element', value: 'element_id' });
      });

      it('reads getLabel from the description NODE, not from the first labelled node it holds', () => {
         // Keyed lookup: a provider answering for a different node must leave the
         // fallback arm of `getLabel(node) ?? description.name` in charge, which a
         // label map that is merely empty cannot distinguish.
         const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne' });
         const other = makeFakeAstNode<AstNode>({ $type: 'TypeTwo' });
         const descriptions = [makeFakeDescription('Foo', { node })];
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub(new Map([[other, 'ns.Other']])))
         );
         const candidates = provider.find({
            source: { uri: 'memory://test' },
            property: 'ref'
         });
         expect(candidates[0]).toEqual({ uri: 'memory://test', type: 'Fake', label: 'Foo', value: 'Foo' });
      });
   });

   describe('adopter override hooks', () => {
      it('subclass can override scopedReferenceInfo to add custom fields', () => {
         interface RichScopedReferenceInfo extends ScopedReferenceInfo {
            dataModelId: string;
         }
         class RichProvider extends DefaultReferenceCandidateProvider {
            protected override scopedReferenceInfo(info: ReferenceInfo): RichScopedReferenceInfo {
               return { ...super.scopedReferenceInfo(info), dataModelId: 'myDM' };
            }
            getRichSource(scope: CandidateScope): RichScopedReferenceInfo {
               return scope.source as RichScopedReferenceInfo;
            }
         }
         const provider = new RichProvider(
            makeServicesStub(makeScopeProviderStub([makeFakeDescription('A')]), makeLabelProviderStub(), 'myDM')
         );
         const scope = provider.getCandidateScope(makeReferenceInfo());
         expect(provider.getRichSource(scope).dataModelId).toBe('myDM');
      });

      it('subclass can override filterCandidate for grammar-specific filtering', () => {
         const descriptions = [makeFakeDescription('keep_me'), makeFakeDescription('drop_me')];
         class FilteredProvider extends DefaultReferenceCandidateProvider {
            protected override filterCandidate(description: AstNodeDescription, _reference: ScopedReferenceInfo): boolean {
               return description.name.startsWith('keep_');
            }
         }
         const provider = new FilteredProvider(makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub()));
         const scope = provider.getCandidateScope(makeReferenceInfo());
         const names = scope.elementScope
            .getAllElements()
            .map(d => d.name)
            .toArray();
         expect(names).toEqual(['keep_me']);
      });

      it('subclass can override buildCandidate for custom label/value separation', () => {
         const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne' });
         const descriptions = [makeFakeDescription('Foo', { node })];
         class LabelPrefixingProvider extends DefaultReferenceCandidateProvider {
            protected override buildCandidate(description: AstNodeDescription, scope: CandidateScope) {
               const base = super.buildCandidate(description, scope);
               return { ...base, label: 'ns.' + base.label };
            }
         }
         const provider = new LabelPrefixingProvider(makeServicesStub(makeScopeProviderStub(descriptions), makeLabelProviderStub()));
         const candidates = provider.find({
            source: { uri: 'memory://test' },
            property: 'ref'
         });
         expect(candidates[0].label).toBe('ns.Foo');
         expect(candidates[0].value).toBe('Foo');
      });
   });

   describe('resolveCandidate', () => {
      function makeResolvingScopeProvider(node: AstNode | undefined): HydraniumScopeProvider {
         return {
            resolveReference: () => node,
            getScope: () => ({ getAllElements: () => stream([]), getElement: () => undefined }),
            referenceContextToInfo: () => ({ reference: { $refText: '', ref: undefined }, container: {} as AstNode, property: 'ref' }),
            sortText: (description: AstNodeDescription) => description.name
         } as unknown as HydraniumScopeProvider;
      }
      function makeTargetNode(): AstNode {
         const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne' });
         (node as unknown as { $document: { uri: URI } }).$document = { uri: URI.parse('memory://target.a') };
         return node;
      }

      it('builds a target candidate plus the resolved node', () => {
         const node = makeTargetNode();
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeResolvingScopeProvider(node), makeLabelProviderStub())
         );
         const resolved = provider.resolveCandidate({ source: { uri: 'memory://a.a' }, property: 'ref', value: 'Element' });
         expect(resolved?.node).toBe(node);
         expect(resolved?.candidate).toEqual({ uri: 'memory://target.a', type: 'TypeOne', label: 'Element', value: 'Element' });
      });

      it('returns undefined when the reference does not resolve', () => {
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeResolvingScopeProvider(undefined), makeLabelProviderStub())
         );
         expect(provider.resolveCandidate({ source: { uri: 'memory://a.a' }, property: 'ref', value: 'X' })).toBeUndefined();
      });

      it('uses the display name as label when distinct from the value', () => {
         const node = makeTargetNode();
         const provider = new DefaultReferenceCandidateProvider(
            makeServicesStub(makeResolvingScopeProvider(node), makeLabelProviderStub(new Map([[node, 'ns.Element']])))
         );
         const resolved = provider.resolveCandidate({ source: { uri: 'memory://a.a' }, property: 'ref', value: 'element_id' });
         expect(resolved?.candidate.label).toBe('ns.Element');
         expect(resolved?.candidate.value).toBe('element_id');
      });
   });

   it('yields no candidates when the outer scope holds nothing', () => {
      // The empty-input arm of `find`: the dedupe-and-sort pipeline must produce
      // an empty array rather than a one-element artefact of its own seeding.
      const provider = new DefaultReferenceCandidateProvider(makeServicesStub(makeScopeProviderStub([]), makeLabelProviderStub()));

      expect(provider.find({ source: { uri: 'memory://test' }, property: 'ref' })).toEqual([]);
   });
});
