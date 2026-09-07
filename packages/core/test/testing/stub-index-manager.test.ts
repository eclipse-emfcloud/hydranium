/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeStubIndexManager` measured against the `HydraniumIndexManager` it
 * doubles, rather than against itself.
 *
 * Type conformance is not what needs a test here: the three read methods ride
 * `Pick<HydraniumIndexManager, …>` in shipped source, so a signature change on
 * any of them already fails `npm run build`. What no compiler sees is the
 * stub's behavioural contract, which has two halves and both matter:
 *
 * - **Where it claims to MATCH the real manager** — the unfiltered and
 *   exact-type queries, and the `uris` narrowing. A suite exercising the stub
 *   alone would pass under any answer the stub chose to give, so the two are
 *   seeded with one index and compared query-by-query.
 * - **Where it claims to DIVERGE** — the stub's own doc states that `nodeType`
 *   is an exact `type` match rather than the real `AstReflection.isSubtype`
 *   test, and that a `languageId`-filtered query is unsupported because the
 *   stub binds no `ServiceRegistry`. Those are the two ways a fixture can
 *   silently assert against the stub instead of against the framework, so they
 *   are pinned from both sides: a stub quietly gaining reflection, or a real
 *   manager quietly losing it, reddens here.
 *
 * A differential passes vacuously if the real manager never held the index —
 * two empty managers agree on every question — so each block asserts the real
 * manager's own answer explicitly.
 */

import { describe, expect, it } from 'vitest';
import type { AstNode, AstNodeDescription, AstReflection, LangiumDocument } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { HydraniumIndexManager } from '../../src/langium/workspace/index-manager.js';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import {
   makeFakeAstNode,
   makeFakeDescription,
   makeFakeDocument,
   makeNoopSharedServices,
   makeStubIndexManager,
   makeStubLangiumDocuments,
   makeStubServiceRegistry
} from '../../src/testing/index.js';

const URI_A = 'file:///a.fake';
const URI_B = 'file:///b.fake';
const LANGUAGE_ID = 'fake';

/**
 * `TypeOne` is a subtype of `BaseType`; `TypeTwo` is unrelated. The real
 * manager routes every type filter through `isSubtype`, so this relation is
 * what separates "same answer" from "the stub only matched the concrete type".
 */
const REFLECTION = {
   isSubtype: (subtype: string, supertype: string): boolean => subtype === supertype || (subtype === 'TypeOne' && supertype === 'BaseType')
} as unknown as AstReflection;

function description(name: string, type: string, documentUri: string): AstNodeDescription {
   return makeFakeDescription(name, { type, documentUri: URI.parse(documentUri) });
}

/**
 * Two documents, each exporting a distinctly-typed element plus one that shares
 * a name across both — so a name lookup has a multi-match and a first-match to
 * answer, and a type filter has something to exclude.
 */
const EXPORTS: ReadonlyMap<string, readonly AstNodeDescription[]> = new Map([
   [URI_A, [description('Alpha', 'TypeOne', URI_A), description('Shared', 'TypeOne', URI_A)]],
   [URI_B, [description('Beta', 'TypeTwo', URI_B), description('Shared', 'TypeTwo', URI_B)]]
]);

/** Document order first, then export order — the order the real index reports. */
const SEED: readonly AstNodeDescription[] = [...(EXPORTS.get(URI_A) ?? []), ...(EXPORTS.get(URI_B) ?? [])];

/**
 * The real manager, headless. It reads `Tracer`, `LangiumDocuments`,
 * `ServiceRegistry` and `AstReflection` only; the index is filled through the
 * real `updateContent` lifecycle, with scope computation standing in for the
 * grammar so no parse is involved.
 */
async function realIndexManager(): Promise<HydraniumIndexManager> {
   const serviceRegistry = makeStubServiceRegistry([
      {
         languageId: LANGUAGE_ID,
         fileExtensions: ['.fake'],
         services: {
            references: {
               ScopeComputation: {
                  collectExportedSymbols: async (document: LangiumDocument): Promise<readonly AstNodeDescription[]> =>
                     EXPORTS.get(document.uri.toString()) ?? []
               }
            }
         }
      }
   ]);
   const services = makeNoopSharedServices<ServerSharedServicesMinimal>({
      ServiceRegistry: serviceRegistry,
      AstReflection: REFLECTION,
      workspace: { LangiumDocuments: makeStubLangiumDocuments() }
   });
   const manager = new HydraniumIndexManager(services);
   for (const uri of EXPORTS.keys()) {
      await manager.updateContent(makeFakeDocument<AstNode>(uri, makeFakeAstNode({ $type: 'TypeOne' })));
   }
   return manager;
}

function names(descriptions: readonly AstNodeDescription[]): string[] {
   return descriptions.map(candidate => candidate.name);
}

describe('makeStubIndexManager — differential against HydraniumIndexManager', () => {
   it('streams the same global index, in the same order, on both sides', async () => {
      const real = await realIndexManager();
      const stub = makeStubIndexManager(SEED);

      const realAll = real.allElements().toArray();
      expect(names(stub.allElements().toArray())).toEqual(names(realAll));

      // Two managers holding nothing agree on the line above, so pin what the
      // real one actually streamed: four entries, document order then export
      // order. This fails if `updateContent` never reached the index.
      expect(names(realAll)).toEqual(['Alpha', 'Shared', 'Beta', 'Shared']);
   });

   it('answers an exact-type query identically, including the empty case', async () => {
      const real = await realIndexManager();
      const stub = makeStubIndexManager(SEED);

      for (const type of ['TypeOne', 'TypeTwo', 'Absent']) {
         expect(names(stub.allElements(type).toArray())).toEqual(names(real.allElements(type).toArray()));
      }
      expect(names(real.allElements('TypeOne').toArray())).toEqual(['Alpha', 'Shared']);
      expect(real.allElements('Absent').toArray()).toEqual([]);
   });

   it('narrows allElements to the given document URIs identically', async () => {
      const real = await realIndexManager();
      const stub = makeStubIndexManager(SEED);

      const onlyB = new Set([URI.parse(URI_B).toString()]);
      expect(names(stub.allElements(undefined, onlyB).toArray())).toEqual(names(real.allElements(undefined, onlyB).toArray()));
      expect(names(real.allElements(undefined, onlyB).toArray())).toEqual(['Beta', 'Shared']);
      // An unindexed URI is the discriminating case: it must narrow to nothing
      // rather than fall through to the whole index.
      expect(stub.allElements(undefined, new Set(['file:///nowhere.fake'])).toArray()).toEqual([]);
      expect(real.allElements(undefined, new Set(['file:///nowhere.fake'])).toArray()).toEqual([]);
   });

   it('answers getElementsByName / getElementByName identically for a name query', async () => {
      const real = await realIndexManager();
      const stub = makeStubIndexManager(SEED);

      for (const name of ['Alpha', 'Shared', 'Beta', 'Nope']) {
         expect(names(stub.getElementsByName(name))).toEqual(names(real.getElementsByName(name)));
         expect(stub.getElementByName(name)?.name).toBe(real.getElementByName(name)?.name);
         expect(stub.getElementByName(name)?.type).toBe(real.getElementByName(name)?.type);
      }

      // Anchors: the multi-match is real on both sides and first-match resolves
      // to the earlier document, which is what makes the comparison above mean
      // anything.
      expect(names(real.getElementsByName('Shared'))).toEqual(['Shared', 'Shared']);
      expect(real.getElementsByName('Shared').map(candidate => candidate.documentUri.toString())).toEqual([
         URI.parse(URI_A).toString(),
         URI.parse(URI_B).toString()
      ]);
      expect(real.getElementByName('Shared')?.type).toBe('TypeOne');
      expect(real.getElementByName('Nope')).toBeUndefined();
   });

   it('agrees on an exact-type name query, where reflection makes no difference', async () => {
      const real = await realIndexManager();
      const stub = makeStubIndexManager(SEED);

      expect(names(stub.getElementsByName('Shared', 'TypeTwo'))).toEqual(names(real.getElementsByName('Shared', 'TypeTwo')));
      expect(real.getElementsByName('Shared', 'TypeTwo').map(candidate => candidate.documentUri.toString())).toEqual([
         URI.parse(URI_B).toString()
      ]);
   });
});

describe('makeStubIndexManager — the divergences its doc comment declares', () => {
   it('matches nodeType exactly where the real manager applies isSubtype', async () => {
      const real = await realIndexManager();
      const stub = makeStubIndexManager(SEED);

      // Both sides asserted: a stub that silently gained reflection, or a real
      // manager that silently lost it, would collapse this pair — and either way
      // a fixture naming a supertype would stop asserting what it thinks.
      expect(names(real.allElements('BaseType').toArray())).toEqual(['Alpha', 'Shared']);
      expect(stub.allElements('BaseType').toArray()).toEqual([]);
      expect(names(real.getElementsByName('Alpha', 'BaseType'))).toEqual(['Alpha']);
      expect(stub.getElementsByName('Alpha', 'BaseType')).toEqual([]);
      expect(real.getElementByName('Alpha', 'BaseType')?.name).toBe('Alpha');
      expect(stub.getElementByName('Alpha', 'BaseType')).toBeUndefined();
   });

   it('honours no languageId-filtered query at all, where the real manager routes by URI', async () => {
      const real = await realIndexManager();
      const stub = makeStubIndexManager(SEED);

      // The real manager resolves the owning language through the service
      // registry the stub does not have, so the stub abstains for EVERY id —
      // including the correct one, which is the case a fixture gets wrong.
      expect(names(real.getElementsByName('Alpha', undefined, LANGUAGE_ID))).toEqual(['Alpha']);
      expect(stub.getElementsByName('Alpha', undefined, LANGUAGE_ID)).toEqual([]);
      expect(stub.getElementByName('Alpha', undefined, LANGUAGE_ID)).toBeUndefined();

      // Both abstain on an unregistered id, so that pair discriminates nothing
      // on its own — it is here to show the real manager's filter is live.
      expect(real.getElementsByName('Alpha', undefined, 'other')).toEqual([]);
      expect(stub.getElementsByName('Alpha', undefined, 'other')).toEqual([]);
   });
});

describe('makeStubIndexManager — the seeding surface it declares itself', () => {
   it('exposes descriptions as the live backing array, so a push is visible to queries', () => {
      const stub = makeStubIndexManager(SEED);
      stub.descriptions.push(description('Gamma', 'TypeTwo', URI_B));

      expect(names(stub.allElements().toArray())).toEqual(['Alpha', 'Shared', 'Beta', 'Shared', 'Gamma']);
      expect(stub.getElementByName('Gamma')?.type).toBe('TypeTwo');
   });

   it('copies the initial descriptions rather than aliasing the caller array', () => {
      const initial = [description('Alpha', 'TypeOne', URI_A)];
      const stub = makeStubIndexManager(initial);
      stub.reset();

      expect(initial).toHaveLength(1);
      expect(stub.allElements().toArray()).toEqual([]);
      expect(stub.getElementByName('Alpha')).toBeUndefined();
   });
});
