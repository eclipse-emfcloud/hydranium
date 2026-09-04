/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, EMPTY_SCOPE, type LangiumDocument, MapScope, type Scope } from '@hydranium/langium';
import { type HydraniumAstNodeDescriptionProvider } from '../../../src/langium/scope/ast-node-description-provider.js';
import { DefaultScopeExtensionService, type ScopeExtensionService } from '../../../src/langium/scope/scope-extension-service.js';
import { type TieredAstNodeDescription } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeAstNode, makeFakeDescription, makeNoopLanguageServices } from '../../../src/testing/index.js';

/** Minimal stub for the typed-factory call sites the acceptor uses. */
function fakeDescriptionsProvider(): HydraniumAstNodeDescriptionProvider {
   const make = (tier: 'local' | 'universal', name: string) =>
      ({ name, tier, type: 'Fake', documentUri: undefined!, path: '/' }) as unknown as TieredAstNodeDescription;
   return {
      createLocal: ({ name }: { name: string }) => make('local', name),
      createUniversal: ({ name }: { name: string }) => make('universal', name)
   } as unknown as HydraniumAstNodeDescriptionProvider;
}

const descriptions = fakeDescriptionsProvider();

function makeService(): ScopeExtensionService {
   // Per-language shape: reads its logger via `.shared` (the no-op default) and
   // synthesises descriptions through its own language's AstNodeDescriptionProvider.
   return new DefaultScopeExtensionService(makeNoopLanguageServices({ workspace: { AstNodeDescriptionProvider: descriptions } }));
}

/**
 * Outer scope holding ONE description under `name`, typed `'Outer'` so a
 * collision can be attributed to a layer (extension descriptions are typed
 * `'Fake'`).
 *
 * Layering order is UNOBSERVABLE against `EMPTY_SCOPE`: with nothing in the
 * outer scope there is no name to shadow, so a query answers the same whether
 * the extension sits above or below. Only a colliding name pins the direction.
 */
function outerScopeWith(name: string): Scope {
   return new MapScope([makeFakeDescription(name, { type: 'Outer' })]);
}

function contextWithDocument(): AstNode {
   const document = { parseResult: { value: makeFakeAstNode({ $type: 'Root' }) } } as unknown as LangiumDocument;
   const context = makeFakeAstNode({ $type: 'Container' });
   (context as { $document?: LangiumDocument }).$document = document;
   return context;
}

describe('ScopeExtensionService — getLocalExtensionScope', () => {
   it('returns outer scope unchanged when no extension applies to the reference type', () => {
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['SomeType'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.local({ node: makeFakeAstNode({ $type: 'Foo' }), name: 'foo', document: doc })
      });

      const result = service.getLocalExtensionScope('OtherType', contextWithDocument(), EMPTY_SCOPE);
      expect(result).toBe(EMPTY_SCOPE);
   });

   it('layers local-tier descriptions on top of the outer scope when an extension applies', () => {
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.local({ node: makeFakeAstNode({ $type: 'TypeOne' }), name: 'syntheticSym', document: doc })
      });

      const result = service.getLocalExtensionScope('TypeOne', contextWithDocument(), EMPTY_SCOPE);
      expect(result).not.toBe(EMPTY_SCOPE);
      expect(result.getElement('syntheticSym')?.name).toBe('syntheticSym');
   });

   it('local-tier descriptions SHADOW a same-named outer description', () => {
      // Pins the direction the test above cannot: against EMPTY_SCOPE, "on top"
      // and "below" answer identically. Local sits above, so the extension wins.
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.local({ node: makeFakeAstNode({ $type: 'TypeOne' }), name: 'collide', document: doc })
      });

      const result = service.getLocalExtensionScope('TypeOne', contextWithDocument(), outerScopeWith('collide'));
      expect(result.getElement('collide')?.type).toBe('Fake');
   });

   it('returns outer scope when extensions match the reference type but produce no descriptions', () => {
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['TypeOne'],
         addDescriptions: () => {
            /* contributes nothing */
         }
      });

      const result = service.getLocalExtensionScope('TypeOne', contextWithDocument(), EMPTY_SCOPE);
      expect(result).toBe(EMPTY_SCOPE);
   });

   it('does not call AstUtils.getDocument when no extension matches the reference type', () => {
      // Pins the `extensionsForType.length === 0` early return: with no matching
      // extension the collector must bail before resolving the context document.
      // A context WITHOUT a `$document` makes AstUtils.getDocument throw, so the
      // wrong branch is observable as a thrown error rather than an equivalent
      // empty result.
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['SomeType'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.local({ node: makeFakeAstNode({ $type: 'Foo' }), name: 'foo', document: doc })
      });
      const documentlessContext = makeFakeAstNode({ $type: 'Container' });
      const result = service.getLocalExtensionScope('OtherType', documentlessContext, EMPTY_SCOPE);
      expect(result).toBe(EMPTY_SCOPE);
   });

   it('routes a pushed pre-built local-tier description through the acceptor', () => {
      // A pre-built description handed to `accept.push(...)` must land in the
      // collected scope, not just the ones the factory methods synthesise.
      const service = makeService();
      const prebuilt = {
         name: 'prebuiltSym',
         tier: 'local',
         type: 'Fake',
         documentUri: undefined!,
         path: '/'
      } as unknown as TieredAstNodeDescription;
      service.register({
         id: 'prebuilt',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, _doc, accept) => accept.push(prebuilt)
      });

      const result = service.getLocalExtensionScope('TypeOne', contextWithDocument(), EMPTY_SCOPE);
      expect(result).not.toBe(EMPTY_SCOPE);
      expect(result.getElement('prebuiltSym')?.name).toBe('prebuiltSym');
   });

   it('does not return universal-tier descriptions on the local query', () => {
      const service = makeService();
      service.register({
         id: 'stdlib',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.universal({ node: makeFakeAstNode({ $type: 'Std' }), name: 'stdSym', document: doc })
      });

      const result = service.getLocalExtensionScope('TypeOne', contextWithDocument(), EMPTY_SCOPE);
      expect(result).toBe(EMPTY_SCOPE);
   });
});

describe('ScopeExtensionService — contribution group consumption', () => {
   it('reads `services.references.scopes` and calls each contribution at construction', () => {
      const calls: string[] = [];
      const services = makeNoopLanguageServices({
         workspace: { AstNodeDescriptionProvider: descriptions },
         references: {
            scopes: {
               extra: {
                  registerScopeExtensions: (registry: ScopeExtensionService) => {
                     calls.push('extra');
                     registry.register({
                        id: 'extra',
                        referenceTypes: ['TypeOne'],
                        addDescriptions: (_ctx, _type, doc, accept) =>
                           accept.local({ node: makeFakeAstNode({ $type: 'A' }), name: 'a', document: doc })
                     });
                  }
               },
               stdlib: {
                  registerScopeExtensions: (registry: ScopeExtensionService) => {
                     calls.push('stdlib');
                     registry.register({
                        id: 'stdlib',
                        referenceTypes: ['TypeTwo'],
                        addDescriptions: () => undefined
                     });
                  }
               }
            }
         }
      });
      new DefaultScopeExtensionService(services);
      expect(calls.sort()).toEqual(['extra', 'stdlib']);
   });
});

describe('ScopeExtensionService — getUniversalExtensionScope', () => {
   it('layers universal-tier descriptions BELOW the outer scope when an extension applies', () => {
      const service = makeService();
      service.register({
         id: 'stdlib',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.universal({ node: makeFakeAstNode({ $type: 'Std' }), name: 'stdSym', document: doc })
      });

      const result = service.getUniversalExtensionScope('TypeOne', contextWithDocument(), EMPTY_SCOPE);
      expect(result).not.toBe(EMPTY_SCOPE);
      expect(result.getElement('stdSym')?.name).toBe('stdSym');
   });

   it('universal-tier descriptions are SHADOWED BY a same-named outer description', () => {
      // The mirror of the local shadowing case, and the assertion that makes
      // "BELOW" mean something: the outer scope wins the collision. Without it,
      // inverting the layering order in getUniversalExtensionScope goes unnoticed.
      const service = makeService();
      service.register({
         id: 'stdlib',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.universal({ node: makeFakeAstNode({ $type: 'Std' }), name: 'collide', document: doc })
      });

      const result = service.getUniversalExtensionScope('TypeOne', contextWithDocument(), outerScopeWith('collide'));
      expect(result.getElement('collide')?.type).toBe('Outer');
   });

   it('does not return local-tier descriptions on the universal query', () => {
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.local({ node: makeFakeAstNode({ $type: 'TypeOne' }), name: 'localSym', document: doc })
      });

      const result = service.getUniversalExtensionScope('TypeOne', contextWithDocument(), EMPTY_SCOPE);
      expect(result).toBe(EMPTY_SCOPE);
   });
});
