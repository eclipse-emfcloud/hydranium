/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { type AstNode, type LangiumDocument } from '@hydranium/langium';
import { Logger } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { type HydraniumAstNodeDescriptionProvider } from '../../../src/langium/scope/ast-node-description-provider.js';
import { type ServerLanguageServices } from '../../../src/langium/language-module.js';
import {
   DefaultScopeExtensionService,
   type ScopeExtension,
   type ScopeExtensionService
} from '../../../src/langium/scope/scope-extension-service.js';
import { type TieredAstNodeDescription } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeCapturingTracer, makeFakeAstNode, makeNoopLanguageServices, makeStubDocumentBuilder } from '../../../src/testing/index.js';

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

function contextWithDocument(): AstNode {
   const document = { parseResult: { value: makeFakeAstNode({ $type: 'Root' }) } } as unknown as LangiumDocument;
   const context = makeFakeAstNode({ $type: 'Container' });
   (context as { $document?: LangiumDocument }).$document = document;
   return context;
}

function names(tier: readonly TieredAstNodeDescription[]): string[] {
   return tier.map(description => description.name);
}

describe('ScopeExtensionService — getDescriptions', () => {
   it('runs each matching extension once per call', () => {
      const service = makeService();
      let calls = 0;
      service.register({
         id: 'both',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) => {
            calls++;
            accept.local({ node: makeFakeAstNode({ $type: 'A' }), name: 'a', document: doc });
            accept.universal({ node: makeFakeAstNode({ $type: 'B' }), name: 'b', document: doc });
         }
      });

      service.getDescriptions('TypeOne', contextWithDocument());
      expect(calls).toBe(1);
   });

   it('splits the descriptions by tier', () => {
      const service = makeService();
      service.register({
         id: 'both',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, doc, accept) => {
            accept.local({ node: makeFakeAstNode({ $type: 'A' }), name: 'localSym', document: doc });
            accept.universal({ node: makeFakeAstNode({ $type: 'B' }), name: 'stdSym', document: doc });
         }
      });

      const result = service.getDescriptions('TypeOne', contextWithDocument());
      expect(names(result.local)).toEqual(['localSym']);
      expect(names(result.universal)).toEqual(['stdSym']);
   });

   it('answers no descriptions when no extension applies to the reference type', () => {
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['SomeType'],
         addDescriptions: (_ctx, _type, doc, accept) =>
            accept.local({ node: makeFakeAstNode({ $type: 'Foo' }), name: 'foo', document: doc })
      });

      const result = service.getDescriptions('OtherType', contextWithDocument());
      expect(result.local).toHaveLength(0);
      expect(result.universal).toHaveLength(0);
   });

   it('does not resolve the context document when no extension matches the reference type', () => {
      // A context WITHOUT a `$document` makes AstUtils.getDocument throw, so a
      // missing early return shows as a thrown error rather than an equal result.
      const service = makeService();
      service.register({
         id: 'extra',
         referenceTypes: ['SomeType'],
         addDescriptions: () => undefined
      });

      expect(() => service.getDescriptions('OtherType', makeFakeAstNode({ $type: 'Container' }))).not.toThrow();
   });

   it('routes a pushed pre-built description to its tier and drops one of another tier', () => {
      const service = makeService();
      const prebuilt = (name: string, tier: string) =>
         ({ name, tier, type: 'Fake', documentUri: undefined!, path: '/' }) as unknown as TieredAstNodeDescription;
      service.register({
         id: 'prebuilt',
         referenceTypes: ['TypeOne'],
         addDescriptions: (_ctx, _type, _doc, accept) => {
            accept.push(prebuilt('prebuiltSym', 'local'));
            accept.push(prebuilt('projectSym', 'project'));
         }
      });

      const result = service.getDescriptions('TypeOne', contextWithDocument());
      expect(names(result.local)).toEqual(['prebuiltSym']);
      expect(result.universal).toHaveLength(0);
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

describe('ScopeExtensionService — profiling', () => {
   const level = Logger.getLevel();
   afterEach(() => Logger.setLevel(level));

   /** A service over a stub builder, so the test starts and ends the builds. */
   function makeProfiledService(create = (services: ServerLanguageServices) => new DefaultScopeExtensionService(services)) {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const builder = makeStubDocumentBuilder();
      const service = create(
         makeNoopLanguageServices({
            shared: { Tracer: tracer, workspace: { DocumentBuilder: builder } },
            workspace: { AstNodeDescriptionProvider: descriptions },
            LanguageMetaData: { languageId: 'test' }
         })
      );
      service.register({ id: 'probe', referenceTypes: ['TypeOne'], addDescriptions: () => undefined });
      const profileLines = () => lines.map(line => line.message).filter(message => message.includes('[profile scope-extension '));
      return { service, builder, profileLines };
   }

   it('reports each extension when a build ends, counting every call', () => {
      const { service, builder, profileLines } = makeProfiledService();
      Logger.setLevel('debug');

      service.getDescriptions('TypeOne', contextWithDocument());
      service.getDescriptions('TypeOne', contextWithDocument());
      expect(profileLines()).toHaveLength(0);

      builder.fireBuildEnded({ completed: true });
      // Count and self-time only: a share of the window would count the time
      // between calls, which a report spanning more than one call includes.
      expect(profileLines()).toEqual([expect.stringMatching(/^\[profile scope-extension test\] probe ×2 [^%\s]+$/)]);
   });

   it('reports when builds that threw have drained', () => {
      const { service, builder, profileLines } = makeProfiledService();
      Logger.setLevel('debug');

      service.getDescriptions('TypeOne', contextWithDocument());
      builder.fireBuildEnded({ completed: false });
      expect(profileLines().filter(message => message.includes('probe ×1'))).toHaveLength(1);
   });

   it('reports the calls made before a build starts apart from the build', () => {
      const { service, builder, profileLines } = makeProfiledService();
      Logger.setLevel('debug');

      service.getDescriptions('TypeOne', contextWithDocument());
      builder.fireOnUpdate([], []);
      service.getDescriptions('TypeOne', contextWithDocument());
      builder.fireBuildEnded({ completed: true });

      expect(profileLines().filter(message => message.includes('probe ×'))).toEqual([
         expect.stringContaining('probe ×1'),
         expect.stringContaining('probe ×1')
      ]);
   });

   it('profiles the extensions an override of extensionsFor chooses', () => {
      class ChoosingService extends DefaultScopeExtensionService {
         protected override extensionsFor(referenceType: string, context: AstNode): ScopeExtension[] {
            return super.extensionsFor(referenceType, context).filter(extension => extension.id !== 'skipped');
         }
      }
      const { service, builder, profileLines } = makeProfiledService(services => new ChoosingService(services));
      let skippedCalls = 0;
      service.register({ id: 'skipped', referenceTypes: ['TypeOne'], addDescriptions: () => void skippedCalls++ });
      Logger.setLevel('debug');

      service.getDescriptions('TypeOne', contextWithDocument());
      builder.fireBuildEnded({ completed: true });
      expect(skippedCalls).toBe(0);
      expect(profileLines()).toEqual([expect.stringContaining('probe ×1')]);
   });

   it('reports nothing at the default info level', () => {
      const { service, builder, profileLines } = makeProfiledService();
      Logger.setLevel('info');

      service.getDescriptions('TypeOne', contextWithDocument());
      builder.fireBuildEnded({ completed: true });
      expect(profileLines()).toHaveLength(0);
   });
});
