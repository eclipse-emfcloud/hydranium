/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { Project } from '@hydranium/protocol';
import { type AstNode, type AstNodeDescription, MapScope, type Scope } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { type HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { HydraniumScopeProvider, type HydraniumScopeProviderOptions } from '../../../src/langium/scope/hydranium-scope-provider.js';
import { type DescriptionTier, type TieredAstNodeDescription } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeDescription, makeTestServices } from '../../../src/testing/index.js';

// ============================================================
// Per-language scope provider test fixture
// ============================================================

/**
 * Per-language services wrapper around a shared `bundle.services`. The
 * merged `HydraniumScopeProvider` is per-language by design, so tests that
 * exercise the project-tier walk construct it with this minimal language
 * wrapper. Returns an `unknown` cast because we only populate the slots
 * the tier walk reads (`shared.*`, `workspace.AstNodeLocator`,
 * `references.ScopeExtensionService`, etc.).
 */
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

/**
 * Build a `HydraniumScopeProvider` against a `makeTestServices` bundle's
 * shared services. The shared services already supply the
 * `ProjectManager`, `LangiumDocuments`, `DocumentBuilder` (for the
 * `WorkspaceCache`), and `Logger` that the merged provider's
 * project-tier walk reads.
 */
function makeTestScopeProvider(sharedServices: unknown, options: HydraniumScopeProviderOptions = {}): HydraniumScopeProvider {
   return new HydraniumScopeProvider(makeLanguageServices(sharedServices), options);
}

// ============================================================
// Helpers
// ============================================================

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

function tieredDescription(tier: DescriptionTier, options: { name: string; uri?: string; projectId?: string }): TieredAstNodeDescription {
   return makeFakeDescription(options.name, {
      documentUri: URI.parse(options.uri ?? 'file:///workspace/fake.x'),
      type: 'FakeRoot',
      path: '',
      tier,
      projectId: options.projectId
   }) as unknown as TieredAstNodeDescription;
}

function makeGlobalScope(descriptions: AstNodeDescription[]): Scope {
   return new MapScope(descriptions);
}

function names(scope: Scope): string[] {
   return scope
      .getAllElements()
      .map(description => description.name)
      .toArray()
      .sort();
}

// ============================================================
// Single-project workspaces
// ============================================================

const REF_TYPE = 'FakeRoot';

/*
 * Both early-exit guards return the input scope WITHOUT running the tier
 * filter, so each fixture below carries a description the filter would drop —
 * a `local`-tier entry, an own-project `public`-tier entry. With plain
 * untagged descriptions the filtered and unfiltered answers are identical and
 * the guard under test is invisible to the assertion.
 */
describe('HydraniumScopeProvider tier walk — early exits from the project filter', () => {
   it('returns the input scope unfiltered when no project owns the source URI', () => {
      // TWO projects, so the isSingleProject fast-path below cannot stand in for
      // the guard this test is about.
      const bundle = makeTestServices<FakeRoot>({
         seedProjects: [
            { id: 'A', referenceName: 'A' },
            { id: 'B', referenceName: 'B' }
         ]
      });
      bundle.projectManager.ownUri('file:///workspace/B.fake', 'B');
      // The source URI is deliberately left unowned — `getProject` returns undefined.
      const provider = makeTestScopeProvider(bundle.services);
      const global = makeGlobalScope([
         makeFakeDescription('a', { documentUri: URI.parse('file:///workspace/A.fake'), type: 'FakeRoot', path: '' }),
         tieredDescription('local', { name: 'local-only', uri: 'file:///workspace/A.fake' })
      ]);

      const result = provider.getProjectScope(URI.parse('file:///workspace/A.fake'), global, REF_TYPE);
      // `local-only` survives only because the filter never ran: the tier walk
      // hides local-tier descriptions unconditionally.
      expect(names(result)).toEqual(['a', 'local-only']);
   });

   it('returns the input scope unfiltered when only one project exists (single-project fast-path)', () => {
      const bundle = makeTestServices<FakeRoot>({
         seedProjects: [{ id: 'single', referenceName: 'single' }]
      });
      bundle.projectManager.ownUri('file:///workspace/A.fake', 'single');
      bundle.projectManager.ownUri('file:///workspace/B.fake', 'single');
      const provider = makeTestScopeProvider(bundle.services);
      const global = makeGlobalScope([
         makeFakeDescription('a', { documentUri: URI.parse('file:///workspace/A.fake'), type: 'FakeRoot', path: '' }),
         // Own-project public tier: the canonical filter hides this one, so its
         // presence in the answer is what proves the fast-path was taken.
         tieredDescription('public', { name: 'A.Public', uri: 'file:///workspace/A.fake', projectId: 'single' })
      ]);

      const result = provider.getProjectScope(URI.parse('file:///workspace/A.fake'), global, REF_TYPE);
      expect(names(result)).toEqual(['A.Public', 'a']);
   });
});

// ============================================================
// Multi-project workspaces
// ============================================================

describe('HydraniumScopeProvider tier walk — multi-project workspace', () => {
   const URI_A = 'file:///workspace/projA/Element.fake';
   const URI_B = 'file:///workspace/projB/Element.fake';
   const URI_C = 'file:///workspace/projC/Element.fake';

   function makeProvider(
      projects: Project[],
      ownership: Record<string, string>
   ): {
      provider: HydraniumScopeProvider;
      global: Scope;
   } {
      const bundle = makeTestServices<FakeRoot>({ seedProjects: projects });
      for (const [uri, projectId] of Object.entries(ownership)) {
         bundle.projectManager.ownUri(uri, projectId);
      }
      const provider = makeTestScopeProvider(bundle.services);
      const global = makeGlobalScope([
         makeFakeDescription('A.Element', { documentUri: URI.parse(URI_A), type: 'FakeRoot', path: '' }),
         makeFakeDescription('B.Element', { documentUri: URI.parse(URI_B), type: 'FakeRoot', path: '' }),
         makeFakeDescription('C.Element', { documentUri: URI.parse(URI_C), type: 'FakeRoot', path: '' })
      ]);
      return { provider, global };
   }

   it("hides descriptions whose owning project is not in the source's visibility closure", () => {
      // A and B and C are independent — A only sees itself.
      const { provider, global } = makeProvider(
         [
            { id: 'A', referenceName: 'A' },
            { id: 'B', referenceName: 'B' },
            { id: 'C', referenceName: 'C' }
         ],
         { [URI_A]: 'A', [URI_B]: 'B', [URI_C]: 'C' }
      );

      expect(names(provider.getProjectScope(URI.parse(URI_A), global, REF_TYPE))).toEqual(['A.Element']);
      expect(names(provider.getProjectScope(URI.parse(URI_B), global, REF_TYPE))).toEqual(['B.Element']);
   });

   it('includes descriptions from declared dependencies (direct)', () => {
      // A depends on B; A sees A + B but not C.
      const { provider, global } = makeProvider(
         [
            { id: 'A', referenceName: 'A', dependencies: ['B'] },
            { id: 'B', referenceName: 'B' },
            { id: 'C', referenceName: 'C' }
         ],
         { [URI_A]: 'A', [URI_B]: 'B', [URI_C]: 'C' }
      );

      expect(names(provider.getProjectScope(URI.parse(URI_A), global, REF_TYPE))).toEqual(['A.Element', 'B.Element']);
      expect(names(provider.getProjectScope(URI.parse(URI_B), global, REF_TYPE))).toEqual(['B.Element']);
   });

   it('walks dependencies transitively', () => {
      // A → B → C: A sees everything, B sees B + C, C sees only itself.
      const { provider, global } = makeProvider(
         [
            { id: 'A', referenceName: 'A', dependencies: ['B'] },
            { id: 'B', referenceName: 'B', dependencies: ['C'] },
            { id: 'C', referenceName: 'C' }
         ],
         { [URI_A]: 'A', [URI_B]: 'B', [URI_C]: 'C' }
      );

      expect(names(provider.getProjectScope(URI.parse(URI_A), global, REF_TYPE))).toEqual(['A.Element', 'B.Element', 'C.Element']);
      expect(names(provider.getProjectScope(URI.parse(URI_B), global, REF_TYPE))).toEqual(['B.Element', 'C.Element']);
      expect(names(provider.getProjectScope(URI.parse(URI_C), global, REF_TYPE))).toEqual(['C.Element']);
   });

   it('handles dependency cycles without infinite recursion (ProjectManager closure terminates)', () => {
      // A ↔ B cycle: each sees both (the framework `AbstractProjectManager.collectVisibleProjects`
      // uses a `visited` set to terminate the walk).
      const { provider, global } = makeProvider(
         [
            { id: 'A', referenceName: 'A', dependencies: ['B'] },
            { id: 'B', referenceName: 'B', dependencies: ['A'] },
            { id: 'C', referenceName: 'C' }
         ],
         { [URI_A]: 'A', [URI_B]: 'B', [URI_C]: 'C' }
      );

      expect(names(provider.getProjectScope(URI.parse(URI_A), global, REF_TYPE))).toEqual(['A.Element', 'B.Element']);
      expect(names(provider.getProjectScope(URI.parse(URI_B), global, REF_TYPE))).toEqual(['A.Element', 'B.Element']);
   });

   it('descriptions outside any project pass through unfiltered', () => {
      // Source A has visibility = [A], but the unowned C.Element still passes
      // because its owning-project id is `undefined` (default treats no-owner
      // as globally visible, not globally hidden).
      const { provider, global } = makeProvider(
         [
            { id: 'A', referenceName: 'A' },
            { id: 'B', referenceName: 'B' }
         ],
         { [URI_A]: 'A', [URI_B]: 'B' /* URI_C left unowned */ }
      );

      expect(names(provider.getProjectScope(URI.parse(URI_A), global, REF_TYPE))).toEqual(['A.Element', 'C.Element']);
   });
});

// ============================================================
// Adopter hook: getProjectIdForDescription
// ============================================================

describe('HydraniumScopeProvider tier walk — adopter hook', () => {
   const URI_A = 'file:///workspace/projA/Element.fake';
   const URI_B = 'file:///workspace/projB/Element.fake';

   /**
    * Subclass that mimics an adopter fast path — descriptions carrying
    * the owning project id directly (no URI → project lookup needed on the
    * hot path).
    */
   class FastPathProjectScopeProvider extends HydraniumScopeProvider {
      readonly lookupCalls: string[] = [];

      protected override getProjectIdForDescription(description: AstNodeDescription): string | undefined {
         const carried = (description as AstNodeDescription & { projectId?: string }).projectId;
         if (carried !== undefined) {
            return carried;
         }
         this.lookupCalls.push(description.name);
         return super.getProjectIdForDescription(description);
      }
   }

   it('subclass override skips the URI lookup when descriptions carry the project id', () => {
      const bundle = makeTestServices<FakeRoot>({
         seedProjects: [
            { id: 'A', referenceName: 'A', dependencies: ['B'] },
            { id: 'B', referenceName: 'B' }
         ]
      });
      bundle.projectManager.ownUri(URI_A, 'A');
      bundle.projectManager.ownUri(URI_B, 'B');
      const provider = new FastPathProjectScopeProvider(makeLanguageServices(bundle.services));

      const carrying = (uri: string, name: string, projectId: string): AstNodeDescription =>
         makeFakeDescription(name, { documentUri: URI.parse(uri), type: 'FakeRoot', path: '', projectId });

      const global = makeGlobalScope([carrying(URI_A, 'A.Element', 'A'), carrying(URI_B, 'B.Element', 'B')]);
      const result = provider.getProjectScope(URI.parse(URI_A), global, REF_TYPE);
      expect(names(result)).toEqual(['A.Element', 'B.Element']);
      // No URI lookups happened on the hot path — every description carried its id.
      expect(provider.lookupCalls).toEqual([]);
   });

   it('subclass override still falls through to URI lookup for descriptions without the carried id', () => {
      const bundle = makeTestServices<FakeRoot>({
         seedProjects: [
            { id: 'A', referenceName: 'A' },
            { id: 'B', referenceName: 'B' }
         ]
      });
      bundle.projectManager.ownUri(URI_A, 'A');
      bundle.projectManager.ownUri(URI_B, 'B');
      const provider = new FastPathProjectScopeProvider(makeLanguageServices(bundle.services));

      const mixed = [
         makeFakeDescription('A.Element', { documentUri: URI.parse(URI_A), type: 'FakeRoot', path: '', projectId: 'A' }),
         makeFakeDescription('B.Element', { documentUri: URI.parse(URI_B), type: 'FakeRoot', path: '' }) // no carried id — falls through.
      ];
      const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope(mixed), REF_TYPE);
      expect(names(result)).toEqual(['A.Element']); // B excluded — its lookup says project B which isn't visible from A.
      expect(provider.lookupCalls).toEqual(['B.Element']);
   });
});

// ============================================================
// Typed scope reading — TieredAstNodeDescription
// ============================================================

describe('HydraniumScopeProvider tier walk — typed scope reading', () => {
   const URI_A = 'file:///workspace/projA/Element.fake';
   const URI_B = 'file:///workspace/projB/Element.fake';

   function makeProvider(projects: Project[], ownership: Record<string, string>) {
      const bundle = makeTestServices<FakeRoot>({ seedProjects: projects });
      for (const [uri, projectId] of Object.entries(ownership)) {
         bundle.projectManager.ownUri(uri, projectId);
      }
      return { bundle, provider: makeTestScopeProvider(bundle.services) };
   }

   describe('tier: public', () => {
      it("passes through public descriptions whose projectId is in the source's dependency closure", () => {
         // A depends on B; B's public-tier descriptions ARE in A's closure.
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A', dependencies: ['B'] },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('public', { name: 'B.Element', uri: URI_B, projectId: 'B' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual(['B.Element']);
      });

      it("hides public descriptions whose projectId is NOT in the source's closure", () => {
         // No dependency declared; B's public-tier is invisible from A.
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('public', { name: 'B.Element', uri: URI_B, projectId: 'B' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual([]);
      });

      it('hides public descriptions whose projectId matches the source (own-project canonical filter)', () => {
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('public', { name: 'A.Element', uri: URI_A, projectId: 'A' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual([]);
      });
   });

   describe('tier: universal', () => {
      it('passes through universal descriptions unconditionally', () => {
         // Need 2+ projects so the isSingleProject fast-path doesn't short-circuit.
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('universal', { name: 'Any' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual(['Any']);
      });
   });

   describe('tier: project (own-project equality)', () => {
      it('passes through project-tier descriptions whose projectId equals the source', () => {
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A', dependencies: ['B'] },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('project', { name: 'A.Element', uri: URI_A, projectId: 'A' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual(['A.Element']);
      });

      it('hides project-tier descriptions from dependent projects (only own project visible)', () => {
         // Even with A→B dep, B's project-tier short names are hidden from A —
         // cross-project access goes through the public-tier (qualified) sibling.
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A', dependencies: ['B'] },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('project', { name: 'B.Element', uri: URI_B, projectId: 'B' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual([]);
      });

      it('hides descriptions whose projectId is not in the visibility set at all', () => {
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('project', { name: 'B.Element', uri: URI_B, projectId: 'B' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual([]);
      });

      it('does NOT trigger the URI-lookup fallback (typed descriptions are the hot path)', () => {
         class Spy extends HydraniumScopeProvider {
            readonly lookupCalls: string[] = [];
            protected override getProjectIdForDescription(description: AstNodeDescription): string | undefined {
               this.lookupCalls.push(description.name);
               return super.getProjectIdForDescription(description);
            }
         }
         const { bundle } = makeProvider(
            [
               { id: 'A', referenceName: 'A', dependencies: ['B'] },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const spy = new Spy(makeLanguageServices(bundle.services));
         const description = tieredDescription('project', { name: 'A.Element', uri: URI_A, projectId: 'A' });
         spy.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(spy.lookupCalls).toEqual([]);
      });
   });

   describe('tier: local', () => {
      it('hides local descriptions defensively (they should not appear in the global index)', () => {
         // Need 2+ projects so the filter actually runs (isSingleProject fast-path
         // would short-circuit a single-project setup).
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const description = tieredDescription('local', { name: 'L', uri: URI_A });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([description]), REF_TYPE);
         expect(names(result)).toEqual([]);
      });
   });

   describe('untagged fallback', () => {
      it('preserves the URI-lookup fallback for plain descriptions', () => {
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A', dependencies: ['B'] },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const plain = makeFakeDescription('B.Element', { documentUri: URI.parse(URI_B), type: 'FakeRoot', path: '' }); // No `tier` field — must go through URI lookup.
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([plain]), REF_TYPE);
         expect(names(result)).toEqual(['B.Element']);
      });
   });

   describe('includeOwnProjectPublic option', () => {
      it('hides own-project public-tier descriptions by default (strict own-project canonical filter)', () => {
         const { bundle } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const provider = makeTestScopeProvider(bundle.services);
         const ownPublic = tieredDescription('public', { name: 'A.Element', uri: URI_A, projectId: 'A' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([ownPublic]), REF_TYPE);
         expect(names(result)).toEqual([]);
      });

      it('makes own-project public-tier descriptions visible in the resolution scope when enabled', () => {
         const { bundle } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const provider = makeTestScopeProvider(bundle.services, { includeOwnProjectPublic: true });
         const ownPublic = tieredDescription('public', { name: 'A.Element', uri: URI_A, projectId: 'A' });
         const ownProject = tieredDescription('project', { name: 'Element', uri: URI_A, projectId: 'A' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([ownPublic, ownProject]), REF_TYPE);
         expect(names(result)).toEqual(['A.Element', 'Element']);
      });

      it('does not affect cross-project public-tier visibility (still gated on the dependency closure)', () => {
         const { bundle } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         const provider = makeTestScopeProvider(bundle.services, { includeOwnProjectPublic: true });
         // B is NOT a dependency of A — its public-tier stays hidden regardless of the option.
         const otherPublic = tieredDescription('public', { name: 'B.Element', uri: URI_B, projectId: 'B' });
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope([otherPublic]), REF_TYPE);
         expect(names(result)).toEqual([]);
      });
   });

   describe('mixed', () => {
      it('routes typed via fields and untagged via URI in the same scope query', () => {
         const { provider } = makeProvider(
            [
               { id: 'A', referenceName: 'A' },
               { id: 'B', referenceName: 'B' },
               { id: 'C', referenceName: 'C' }
            ],
            { [URI_A]: 'A', [URI_B]: 'B' }
         );
         // From source A (visibility = [A] only):
         // - typed project-tier B: hidden (B not in visibility set)
         // - typed universal: visible unconditionally
         // - typed public projectId=A: hidden (own-project canonical filter)
         // - untagged in B (URI lookup → B): hidden
         const descriptions: AstNodeDescription[] = [
            tieredDescription('project', { name: 'TypedB', uri: URI_B, projectId: 'B' }),
            tieredDescription('universal', { name: 'Universal' }),
            tieredDescription('public', { name: 'PublicHome', uri: URI_A, projectId: 'A' }),
            makeFakeDescription('PlainB', { documentUri: URI.parse(URI_B), type: 'FakeRoot', path: '' })
         ];
         const result = provider.getProjectScope(URI.parse(URI_A), makeGlobalScope(descriptions), REF_TYPE);
         expect(names(result)).toEqual(['Universal']);
      });
   });
});
