/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, type LangiumDocument, type LangiumDocuments, stream, type URI } from '@hydranium/langium';
import { makeFakeAstNode, makeFakeDocument, type FakeDocumentOptions } from './fake-document.js';

/**
 * Map-backed stub for Langium's {@link LangiumDocuments} registry. Implements
 * the surface real consumer code reads from on test paths
 * (`getDocument` / `hasDocument` / `getOrCreateDocument` / `all`) plus
 * test-only helpers: `set` (mutate the registry), `clear`, and `entries`
 * (read the backing map directly).
 *
 * # Stub-vs-real surface
 *
 * Picks only the methods the framework reads on test paths from
 * {@link LangiumDocuments}; the compiler enforces those signatures stay
 * aligned with the real interface. Methods Langium adds in the future
 * (or methods the stub doesn't claim — `deleteDocument`, etc.) can't be
 * called through this stub interface; consumers that need them either
 * extend the Pick or wire the real registry.
 *
 * Returned as a structural value rather than a class subclass because
 * Langium doesn't expose a constructable `LangiumDocuments` registry —
 * production code reads the slot value through the `LangiumDocuments`
 * interface and a narrowing cast bridges the stub at the binding site.
 */
export interface StubLangiumDocuments<TAst extends AstNode = AstNode, TDiagnostic = unknown> extends Pick<
   LangiumDocuments,
   'getDocument' | 'hasDocument' | 'getOrCreateDocument' | 'all'
> {
   /**
    * Replace (or insert) the {@link LangiumDocument} at the given URI. Returns
    * the inserted document so call sites can chain to phase-fire helpers
    * without a separate lookup.
    */
   set(uri: string | URI, root: TAst, options?: FakeDocumentOptions<TAst, TDiagnostic>): LangiumDocument<TAst>;
   /** Drop every entry. Useful for `beforeEach` resets without rebuilding the bundle. */
   clear(): void;
   /** Direct accessor on the underlying map — for assertion-side reads in tests. */
   readonly entries: ReadonlyMap<string, LangiumDocument<TAst>>;
}

/**
 * Build a {@link StubLangiumDocuments}. Seed entries via the optional
 * `seeds` parameter so simple tests don't need a separate `set` call.
 */
export function makeStubLangiumDocuments<TAst extends AstNode = AstNode, TDiagnostic = unknown>(
   seeds: ReadonlyArray<{ uri: string | URI; root: TAst; options?: FakeDocumentOptions<TAst, TDiagnostic> }> = []
): StubLangiumDocuments<TAst, TDiagnostic> {
   const docs = new Map<string, LangiumDocument<TAst>>();

   const stub: StubLangiumDocuments<TAst, TDiagnostic> = {
      get entries() {
         return docs;
      },
      get all() {
         // A `Stream`, not an array: the picked signature promises one, and
         // framework code reads `documents.all.toArray()`. Returning an array
         // behind the cast let that call throw against the stub while every
         // signature still typechecked. Use `entries` for a size.
         return stream(docs.values()) as unknown as LangiumDocuments['all'];
      },
      set(uri: string | URI, root: TAst, options?: FakeDocumentOptions<TAst, TDiagnostic>) {
         const key = typeof uri === 'string' ? uri : uri.toString();
         const doc = makeFakeDocument<TAst, TDiagnostic>(uri, root, options);
         docs.set(key, doc);
         return doc;
      },
      clear() {
         docs.clear();
      },
      getDocument(uri: URI) {
         return docs.get(uri.toString()) as LangiumDocument | undefined;
      },
      hasDocument(uri: URI) {
         return docs.has(uri.toString());
      },
      async getOrCreateDocument(uri: URI) {
         const existing = docs.get(uri.toString());
         if (existing) {
            return existing as LangiumDocument;
         }
         // Registered on creation, as `DefaultLangiumDocuments` does — a
         // caller that reads it back through `getDocument` must find it. The
         // root is a `$type: 'unknown'` placeholder because the stub has no
         // parser, so a test asserting on the root has to `set` first.
         const placeholder = makeFakeDocument(uri, makeFakeAstNode<TAst>({ $type: 'unknown' }));
         docs.set(uri.toString(), placeholder);
         return placeholder as LangiumDocument;
      }
   };

   for (const seed of seeds) {
      stub.set(seed.uri, seed.root, seed.options);
   }
   return stub;
}
