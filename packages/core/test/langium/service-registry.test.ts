/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumCoreServices, type LangiumSharedCoreServices } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { createServerSharedModule, type ServerModuleContext } from '../../src/langium/module.js';
import { makeFakeAstNode } from '../../src/testing/fake-document.js';
import { ExtendedServiceRegistry, type TypedLanguageMetaData, typedMetadata } from '../../src/langium/service-registry.js';

interface AlphaServices extends LangiumCoreServices {
   readonly tag: 'alpha';
}
interface BetaServices extends LangiumCoreServices {
   readonly tag: 'beta';
}

function makeServices<TServices extends LangiumCoreServices & { tag: string }>(
   tag: TServices['tag'],
   languageId: string,
   fileExtensions: readonly string[]
): TServices {
   return {
      LanguageMetaData: { languageId, fileExtensions, caseInsensitive: false, mode: 'production' },
      tag
   } as unknown as TServices;
}

const AlphaMeta = typedMetadata<AlphaServices>({
   languageId: 'alpha',
   fileExtensions: ['.a'],
   caseInsensitive: false,
   mode: 'production'
});
const BetaMeta = typedMetadata<BetaServices>({
   languageId: 'beta',
   fileExtensions: ['.b'],
   caseInsensitive: false,
   mode: 'production'
});

describe('ExtendedServiceRegistry', () => {
   it('getServices(metadata) returns the registered services typed by the handle', () => {
      const registry = new ExtendedServiceRegistry();
      const alpha = makeServices<AlphaServices>('alpha', 'alpha', ['.a']);
      registry.register(alpha);

      const resolved = registry.getServices(AlphaMeta);
      // Type is inferred as `AlphaServices | undefined` — no caller-side cast.
      expect(resolved?.tag).toBe('alpha');
   });

   it('getServices(metadata) returns undefined for an unregistered language', () => {
      const registry = new ExtendedServiceRegistry();
      registry.register(makeServices<AlphaServices>('alpha', 'alpha', ['.a']));
      expect(registry.getServices(BetaMeta)).toBeUndefined();
   });

   it('getServices(uri) preserves Langium inherited URI-keyed semantics', () => {
      const registry = new ExtendedServiceRegistry();
      const alpha = makeServices<AlphaServices>('alpha', 'alpha', ['.a']);
      registry.register(alpha);

      const resolved = registry.getServices(URI.parse('file:///workspace/x.a'));
      expect(resolved).toBe(alpha);
   });

   it('getServicesById returns the language services for the given id, undefined for unregistered', () => {
      const registry = new ExtendedServiceRegistry();
      const alpha = makeServices<AlphaServices>('alpha', 'alpha', ['.a']);
      registry.register(alpha);
      expect(registry.getServicesById('alpha')).toBe(alpha);
      expect(registry.getServicesById('unknown')).toBeUndefined();
   });

   it('getServicesByExtension returns the language services for the given extension', () => {
      const registry = new ExtendedServiceRegistry();
      const alpha = makeServices<AlphaServices>('alpha', 'alpha', ['.a']);
      registry.register(alpha);
      expect(registry.getServicesByExtension('.a')).toBe(alpha);
      expect(registry.getServicesByExtension('.unknown')).toBeUndefined();
   });

   it('createServerSharedModule binds ServiceRegistry to an ExtendedServiceRegistry instance', () => {
      const module = createServerSharedModule({} as ServerModuleContext);
      // `Module<I, T>` types each slot as the recursively-mapped module value
      // (factory-or-nested-module union), so TS can't see that this leaf slot is
      // directly callable. The runtime value is a `(injector) => registry` factory.
      const serviceRegistryFactory = module.ServiceRegistry as unknown as (
         injector: LangiumCoreServices['shared']
      ) => ExtendedServiceRegistry;
      const registry = serviceRegistryFactory({} as LangiumCoreServices['shared']);
      expect(registry).toBeInstanceOf(ExtendedServiceRegistry);
   });

   describe('declared-languageId lookup rung', () => {
      /** Shared-services shell exposing only what the registry reads: open documents' declared ids. */
      function sharedWithOpen(openLanguageIds: Record<string, string>): LangiumSharedCoreServices {
         return {
            workspace: {
               TextDocuments: {
                  get: (uri: string | URI) => {
                     const languageId = openLanguageIds[uri.toString()];
                     return languageId === undefined ? undefined : { languageId };
                  }
               }
            }
         } as unknown as LangiumSharedCoreServices;
      }

      function twoLanguages(shared?: LangiumSharedCoreServices): ExtendedServiceRegistry {
         const registry = new ExtendedServiceRegistry(shared);
         registry.register(makeServices<AlphaServices>('alpha', 'alpha', ['.a']));
         registry.register(makeServices<BetaServices>('beta', 'beta', ['.b']));
         return registry;
      }

      it("takes an open document's declared id ahead of its extension", () => {
         const registry = twoLanguages(sharedWithOpen({ 'file:///x.a': 'beta' }));
         expect(registry.getServices(URI.parse('file:///x.a')).LanguageMetaData.languageId).toBe('beta');
      });

      it('resolves an extensionless URI that only its declared id can route', () => {
         // The untitled-buffer case. Langium 4.3.1 has no sole-language
         // fallback despite its interface doc, so without this rung an
         // extensionless URI throws no matter how many languages are registered.
         const registry = twoLanguages(sharedWithOpen({ 'untitled:Untitled-1': 'beta' }));
         expect(registry.getServices(URI.parse('untitled:Untitled-1')).LanguageMetaData.languageId).toBe('beta');
      });

      it('falls through to the extension for a declared id nothing is registered for', () => {
         // A stale client contribution, or a plain-text buffer — not an error.
         const registry = twoLanguages(sharedWithOpen({ 'file:///x.a': 'not-registered' }));
         expect(registry.getServices(URI.parse('file:///x.a')).LanguageMetaData.languageId).toBe('alpha');
      });

      it('still routes by extension when no shared services were supplied', () => {
         expect(twoLanguages().getServices(URI.parse('file:///x.b')).LanguageMetaData.languageId).toBe('beta');
      });

      it('accepts shared services after construction, without replacing an existing reference', () => {
         const late = twoLanguages();
         late.acceptSharedServices(sharedWithOpen({ 'file:///x.a': 'beta' }));
         expect(late.getServices(URI.parse('file:///x.a')).LanguageMetaData.languageId).toBe('beta');

         const explicit = twoLanguages(sharedWithOpen({ 'file:///x.a': 'beta' }));
         explicit.acceptSharedServices(sharedWithOpen({ 'file:///x.a': 'alpha' }));
         expect(explicit.getServices(URI.parse('file:///x.a')).LanguageMetaData.languageId).toBe('beta');
      });
   });

   describe('servicesFor (per-target lookup)', () => {
      function twoLanguages(): ExtendedServiceRegistry {
         const registry = new ExtendedServiceRegistry();
         registry.register(makeServices<AlphaServices>('alpha', 'first', ['.one']));
         registry.register(makeServices<BetaServices>('beta', 'second', ['.two']));
         return registry;
      }

      /** A root node carrying a `$document`, so `AstUtils` can route it. */
      function nodeInDoc(uri: string): AstNode {
         return makeFakeAstNode<AstNode>({ $type: 'Thing', $document: { uri: URI.parse(uri) } });
      }

      it('routes a URI', () => {
         expect(twoLanguages().getServicesFor(URI.parse('file:///a.two'))?.LanguageMetaData.languageId).toBe('second');
      });

      it('routes a URI string', () => {
         expect(twoLanguages().getServicesFor('file:///a.one')?.LanguageMetaData.languageId).toBe('first');
      });

      it('routes an AST node by the document it lives in', () => {
         expect(twoLanguages().getServicesFor(nodeInDoc('file:///a.two'))?.LanguageMetaData.languageId).toBe('second');
      });

      it('abstains instead of throwing for an unroutable URI', () => {
         expect(twoLanguages().getServicesFor('file:///a.unknown')).toBeUndefined();
      });

      it('abstains for a node with no document, and for undefined', () => {
         expect(twoLanguages().getServicesFor(makeFakeAstNode<AstNode>({ $type: 'Thing' }))).toBeUndefined();
         expect(twoLanguages().getServicesFor(undefined)).toBeUndefined();
      });
   });

   describe('producible-type lookup', () => {
      /** Language services carrying a grammar that produces exactly `types`. */
      function producing(languageId: string, ...types: string[]): LangiumCoreServices {
         return {
            LanguageMetaData: { languageId, fileExtensions: [`.${languageId}`], caseInsensitive: false, mode: 'production' },
            Grammar: {
               $type: 'Grammar',
               rules: types.map(name => ({ $type: 'ParserRule', name, definition: { $type: 'Group', elements: [] } }))
            }
         } as unknown as LangiumCoreServices;
      }

      it('returns every owner of a type, so the caller can tell none from several', () => {
         const registry = new ExtendedServiceRegistry();
         registry.register(producing('alpha', 'TypeOne', 'SharedType'));
         registry.register(producing('beta', 'TypeTwo', 'SharedType'));

         expect(registry.getServicesByType('TypeOne').map(l => l.LanguageMetaData.languageId)).toEqual(['alpha']);
         expect(registry.getServicesByType('SharedType').map(l => l.LanguageMetaData.languageId)).toEqual(['alpha', 'beta']);
         expect(registry.getServicesByType('UnknownType')).toEqual([]);
      });

      it('soleServicesByType abstains on both no-owner and several-owners', () => {
         const registry = new ExtendedServiceRegistry();
         registry.register(producing('alpha', 'TypeOne', 'SharedType'));
         registry.register(producing('beta', 'TypeTwo', 'SharedType'));

         expect(registry.soleServicesByType('TypeOne')?.LanguageMetaData.languageId).toBe('alpha');
         expect(registry.soleServicesByType('SharedType')).toBeUndefined();
         expect(registry.soleServicesByType('UnknownType')).toBeUndefined();
      });

      it('accounts for a language registered after the index was first built', () => {
         // The reason this index lives on the registry rather than in a
         // consumer's private memo: only the registry knows the set changed.
         const registry = new ExtendedServiceRegistry();
         registry.register(producing('alpha', 'SharedType'));
         expect(registry.soleServicesByType('SharedType')?.LanguageMetaData.languageId).toBe('alpha');

         registry.register(producing('beta', 'SharedType'));
         expect(registry.soleServicesByType('SharedType')).toBeUndefined();
         expect(registry.getServicesByType('SharedType')).toHaveLength(2);
      });
   });

   describe('registrations', () => {
      it('counts every register call', () => {
         const registry = new ExtendedServiceRegistry();
         expect(registry.registrations).toBe(0);
         registry.register(makeServices<AlphaServices>('alpha', 'alpha', ['.a']));
         registry.register(makeServices<BetaServices>('beta', 'beta', ['.b']));
         expect(registry.registrations).toBe(2);
      });

      it('advances when a language id is REPLACED, which `all.length` does not', () => {
         // The whole reason the counter exists. `register` writes into a map
         // keyed by language id, so re-registering an id swaps the entry and
         // leaves the length alone — a consumer memoising over the registered
         // set and keyed on the length would keep the replaced language's
         // metadata. The document builder's file-extension cache keys on this
         // counter for exactly that reason.
         const registry = new ExtendedServiceRegistry();
         registry.register(makeServices<AlphaServices>('alpha', 'alpha', ['.a']));
         const lengthBefore = registry.all.length;
         const countBefore = registry.registrations;

         registry.register(makeServices<AlphaServices>('alpha', 'alpha', ['.a', '.a2']));

         expect(registry.all.length).toBe(lengthBefore);
         expect(registry.registrations).toBe(countBefore + 1);
      });
   });

   it('TypedLanguageMetaData brand is invariant — phantom type prevents cross-assignment', () => {
      // Compile-time check: the line below would assign an Alpha handle to a Beta-typed
      // slot; the phantom `unique symbol` brand on `TypedLanguageMetaData<T>` blocks it.
      // Verified via `// @ts-expect-error` — if invariance were lost, the directive would
      // become unused and ts would fail this test at type-check.
      // @ts-expect-error TypedLanguageMetaData<AlphaServices> is not assignable to TypedLanguageMetaData<BetaServices>
      const _wrong: TypedLanguageMetaData<BetaServices> = AlphaMeta;
      void _wrong;

      // Runtime assertion to keep the test from being optimised out.
      expect(AlphaMeta.languageId).toBe('alpha');
      expect(BetaMeta.languageId).toBe('beta');
   });
});
