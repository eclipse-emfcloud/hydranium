/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeStubLangiumDocuments` measured against the `DefaultLangiumDocuments` it
 * doubles, plus the seeding surface it declares itself.
 *
 * The four picked members ride `Pick<LangiumDocuments, …>` in shipped source,
 * so their SIGNATURES already fail `npm run build` on a change. What a compiler
 * cannot see is that the picked signature promises a `Stream` from `all` and
 * the stub reaches it through a cast — the runtime shape can be anything and
 * every call site still typechecks. So `all` is compared against the real
 * registry's, not merely asserted to have the right contents.
 *
 * The other claim compared here is registration: `getOrCreateDocument` on a
 * miss must leave the document findable, which is what `DefaultLangiumDocuments`
 * does through `addDocument`. A stub that returned a placeholder without
 * registering it would let a test's second lookup silently create a second
 * document.
 *
 * A differential passes vacuously if the real registry never held anything, so
 * the real side's own answers are asserted explicitly.
 */

import { describe, expect, it } from 'vitest';
import { DefaultLangiumDocuments, DocumentState, URI, type AstNode, type LangiumDocument } from '@hydranium/langium';
import type { TransferDiagnostic } from '@hydranium/protocol';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import { makeFakeAstNode, makeFakeDocument, makeNoopSharedServices, makeStubLangiumDocuments } from '../../src/testing/index.js';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const URI_A = 'file:///a.fake';
const URI_B = 'file:///b.fake';

function fakeRoot(name: string): FakeRoot {
   return makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name });
}

/**
 * The real registry, headless. It reads exactly one slot —
 * `LangiumDocumentFactory` — and `getOrCreateDocument` is the only path that
 * calls it, so a factory returning a fake document is the whole fixture.
 */
function realDocuments(): DefaultLangiumDocuments {
   const services = makeNoopSharedServices<ServerSharedServicesMinimal>({
      workspace: {
         LangiumDocumentFactory: {
            fromUri: async (uri: URI): Promise<LangiumDocument> =>
               makeFakeDocument<FakeRoot>(uri, fakeRoot('from-factory')) as unknown as LangiumDocument
         }
      }
   });
   return new DefaultLangiumDocuments(services);
}

describe('makeStubLangiumDocuments — differential against DefaultLangiumDocuments', () => {
   it('answers all as a Stream on both sides, in insertion order', async () => {
      const real = realDocuments();
      const stub = makeStubLangiumDocuments<FakeRoot>();

      for (const uri of [URI_A, URI_B]) {
         real.addDocument(makeFakeDocument<FakeRoot>(uri, fakeRoot(uri)) as unknown as LangiumDocument);
         stub.set(uri, fakeRoot(uri));
      }

      // `toArray` is the discriminating call: it exists on Langium's `Stream`
      // and not on an array, so a stub answering an array fails here while
      // leaving every signature and every content assertion intact.
      expect(stub.all.toArray().map(document => document.uri.toString())).toEqual(
         real.all.toArray().map(document => document.uri.toString())
      );
      expect(real.all.toArray().map(document => document.uri.toString())).toEqual([
         URI.parse(URI_A).toString(),
         URI.parse(URI_B).toString()
      ]);
   });

   it('registers a document created by getOrCreateDocument, on both sides', async () => {
      const real = realDocuments();
      const stub = makeStubLangiumDocuments<FakeRoot>();

      const target = URI.parse(URI_A);
      expect(real.hasDocument(target)).toBe(false);
      expect(stub.hasDocument(target)).toBe(false);

      const fromReal = await real.getOrCreateDocument(target);
      const fromStub = await stub.getOrCreateDocument(target);

      // The registration claim: a second lookup finds the SAME instance rather
      // than creating a second document for the same URI.
      expect(real.hasDocument(target)).toBe(true);
      expect(stub.hasDocument(target)).toBe(true);
      expect(await real.getOrCreateDocument(target)).toBe(fromReal);
      expect(await stub.getOrCreateDocument(target)).toBe(fromStub);
      expect(real.getDocument(target)).toBe(fromReal);
      expect(stub.getDocument(target)).toBe(fromStub);
      // The stub has no parser, so the created root is an explicit placeholder
      // rather than whatever the factory would have produced.
      expect(fromStub.parseResult.value.$type).toBe('unknown');
      expect((fromReal.parseResult.value as FakeRoot).name).toBe('from-factory');
   });

   it('returns the existing document rather than a fresh one when the URI is already held', async () => {
      const real = realDocuments();
      const stub = makeStubLangiumDocuments<FakeRoot>();

      const seeded = makeFakeDocument<FakeRoot>(URI_A, fakeRoot('seeded'));
      real.addDocument(seeded as unknown as LangiumDocument);
      const stubSeeded = stub.set(URI_A, fakeRoot('seeded'));

      expect(await real.getOrCreateDocument(URI.parse(URI_A))).toBe(seeded);
      expect(await stub.getOrCreateDocument(URI.parse(URI_A))).toBe(stubSeeded);
      // Anchor: the factory would have produced a differently-named root, so
      // this fails if the existing-document branch were skipped.
      expect((real.getDocument(URI.parse(URI_A))?.parseResult.value as FakeRoot).name).toBe('seeded');
   });

   it('answers getDocument / hasDocument by canonicalised URI string on both sides', () => {
      const real = realDocuments();
      const stub = makeStubLangiumDocuments<FakeRoot>();

      real.addDocument(makeFakeDocument<FakeRoot>(URI_A, fakeRoot('a')) as unknown as LangiumDocument);
      stub.set(URI_A, fakeRoot('a'));

      expect(stub.hasDocument(URI.parse(URI_A))).toBe(real.hasDocument(URI.parse(URI_A)));
      expect(stub.hasDocument(URI.parse(URI_B))).toBe(real.hasDocument(URI.parse(URI_B)));
      expect(real.hasDocument(URI.parse(URI_A))).toBe(true);
      expect(real.hasDocument(URI.parse(URI_B))).toBe(false);
      expect(stub.getDocument(URI.parse(URI_B))).toBeUndefined();
   });
});

describe('makeStubLangiumDocuments — the seeding surface it declares itself', () => {
   it('applies seeds at construction and exposes them through every read', () => {
      const stub = makeStubLangiumDocuments<FakeRoot>([{ uri: URI_A, root: fakeRoot('a') }]);

      expect(stub.hasDocument(URI.parse(URI_A))).toBe(true);
      expect(stub.getDocument(URI.parse(URI_A))?.parseResult.value.$type).toBe('FakeRoot');
      expect(stub.entries.size).toBe(1);
   });

   it('returns the inserted document from set, so a caller can chain without a lookup', () => {
      const stub = makeStubLangiumDocuments<FakeRoot, TransferDiagnostic>();
      const inserted = stub.set(URI_B, fakeRoot('b'), { state: DocumentState.IndexedReferences, version: 7 });

      expect(inserted).toBe(stub.getDocument(URI.parse(URI_B)));
      expect(inserted.state).toBe(DocumentState.IndexedReferences);
      expect(inserted.textDocument.version).toBe(7);
   });

   it('replaces the entry at a URI it already holds instead of adding a second', () => {
      const stub = makeStubLangiumDocuments<FakeRoot>([{ uri: URI_A, root: fakeRoot('first') }]);
      stub.set(URI_A, fakeRoot('second'));

      // The real registry THROWS on `addDocument` for a URI it holds; the stub
      // is a plain map assignment, so a test re-seeding a URI gets the newer
      // root rather than an error.
      expect(stub.entries.size).toBe(1);
      expect((stub.getDocument(URI.parse(URI_A))?.parseResult.value as FakeRoot).name).toBe('second');
   });

   it('exposes entries as the live backing map and empties it on clear', () => {
      const stub = makeStubLangiumDocuments<FakeRoot>([
         { uri: URI_A, root: fakeRoot('a') },
         { uri: URI_B, root: fakeRoot('b') }
      ]);
      const entries = stub.entries;

      expect(entries.size).toBe(2);
      stub.clear();
      expect(entries.size).toBe(0);
      expect(stub.all.toArray()).toEqual([]);
      expect(stub.hasDocument(URI.parse(URI_A))).toBe(false);
   });
});
