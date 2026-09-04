/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { URI, UriUtils } from '@hydranium/langium';
import {
   DefaultDocumentUriPolicy,
   type DocumentUriPolicy,
   RealpathDocumentUriPolicy,
   findRealpathDivergence
} from '../../../src/langium/workspace/document-uri-policy.js';
import { documentUriPolicyConformance, makeNoopSharedServices } from '../../../src/testing/index.js';

describe('DefaultDocumentUriPolicy', () => {
   const policy = new DefaultDocumentUriPolicy();

   it('canonicalUri delegates to syntactic UriUtils.normalize (string and URI forms agree)', () => {
      const raw = 'file:///My Folder/x.fake';
      expect(policy.canonicalUri(raw)).toBe(UriUtils.normalize(raw));
      expect(policy.canonicalUri(URI.parse(raw))).toBe(UriUtils.normalize(raw));
   });

   it('canonicalUri is idempotent', () => {
      const once = policy.canonicalUri('file:///a/b/../c.fake');
      expect(policy.canonicalUri(once)).toBe(once);
   });

   it('loadUri treats every URI as loadable — returns it unchanged, never undefined', () => {
      expect(policy.loadUri('file:///a/x.fake')?.toString()).toBe(UriUtils.toUri('file:///a/x.fake')?.toString());
   });
});

describe('RealpathDocumentUriPolicy', () => {
   // A fake filesystem realpath standing in for the Node provider: a symlinked
   // path resolves to its real path, a known-absent path reports `undefined`,
   // everything else passes through unchanged. Lets the policy's routing be
   // pinned without touching disk.
   const REAL = URI.parse('file:///real/x.fake');
   const LINK = 'file:///link/x.fake';
   const ABSENT = 'file:///gone/y.fake';
   const realpath = (uri: URI): URI | undefined => {
      const text = uri.toString();
      if (text === LINK) {
         return REAL;
      }
      if (text === ABSENT) {
         return undefined;
      }
      return uri;
   };

   const makePolicy = (fsRealpath?: (uri: URI) => URI | undefined): RealpathDocumentUriPolicy =>
      new RealpathDocumentUriPolicy(makeNoopSharedServices({ workspace: { FileSystemProvider: { realpath: fsRealpath } } }));

   it('canonicalUri resolves a symlinked path to its real-path canonical form', () => {
      expect(makePolicy(realpath).canonicalUri(LINK)).toBe(UriUtils.normalize(REAL));
   });

   it('canonicalUri falls back to the syntactic form when realpath reports the path absent', () => {
      expect(makePolicy(realpath).canonicalUri(ABSENT)).toBe(UriUtils.normalize(ABSENT));
   });

   it('loadUri returns the resolved real-path URI', () => {
      expect(makePolicy(realpath).loadUri(LINK)?.toString()).toBe(REAL.toString());
   });

   it('loadUri returns undefined when realpath reports the path absent', () => {
      expect(makePolicy(realpath).loadUri(ABSENT)).toBeUndefined();
   });

   it('degrades to the default when the provider has no realpath: canonicalUri normalizes', () => {
      expect(makePolicy(undefined).canonicalUri(LINK)).toBe(UriUtils.normalize(LINK));
   });

   it('degrades to the default when the provider has no realpath: loadUri never returns undefined', () => {
      // The existence signal must survive ONLY where realpath is present-and-absent;
      // with no realpath at all, loadUri is the optimistic default (never undefined).
      expect(makePolicy(undefined).loadUri(ABSENT)?.toString()).toBe(UriUtils.toUri(ABSENT)?.toString());
   });
});

describe('findRealpathDivergence', () => {
   const REAL = URI.parse('file:///real/x.fake');
   const LINK = 'file:///link/x.fake';
   const ABSENT = 'file:///gone/y.fake';
   const fs = {
      realpath: (uri: URI): URI | undefined => {
         const text = uri.toString();
         if (text === LINK) {
            return REAL; // symlink → resolves elsewhere (divergent)
         }
         if (text === ABSENT) {
            return undefined; // filesystem reports absent
         }
         return uri; // present, non-divergent → unchanged
      }
   };

   it('reports the real URI when realpath differs from the syntactic spelling', () => {
      expect(findRealpathDivergence(LINK, fs)?.toString()).toBe(REAL.toString());
   });

   it('returns undefined for a path whose realpath equals its normalized spelling', () => {
      expect(findRealpathDivergence(REAL, fs)).toBeUndefined();
   });

   it('returns undefined when the filesystem reports the path absent', () => {
      expect(findRealpathDivergence(ABSENT, fs)).toBeUndefined();
   });

   it('returns undefined when the provider has no realpath (nothing to compare)', () => {
      expect(findRealpathDivergence(LINK, {})).toBeUndefined();
   });
});

// The reusable contract suite, run against both framework policies. A future
// change to either policy (or an adopter's) that breaks idempotency or the
// present-case agreement — the invariants every layer's shared document
// identity rests on — fails here.
documentUriPolicyConformance(
   { describe, it, expect },
   'DefaultDocumentUriPolicy (via conformance kit)',
   () => new DefaultDocumentUriPolicy()
);

documentUriPolicyConformance(
   { describe, it, expect },
   'RealpathDocumentUriPolicy (via conformance kit)',
   () =>
      new RealpathDocumentUriPolicy(
         makeNoopSharedServices({
            // A realpath that resolves one symlinked sample and reports one absent —
            // so the suite exercises the resolve, fallback, and absent branches.
            workspace: {
               FileSystemProvider: {
                  realpath: (uri: URI): URI | undefined => {
                     const text = uri.toString();
                     if (text === 'file:///link/x.fake') {
                        return URI.parse('file:///real/x.fake');
                     }
                     if (text === 'file:///gone/y.fake') {
                        return undefined;
                     }
                     return uri;
                  }
               }
            }
         })
      ),
   { sampleUris: ['file:///link/x.fake', 'file:///gone/y.fake', 'file:///plain/z.fake', 'builtin:///shared.fake'] }
);

// ============================================================
// The conformance kit itself
// ============================================================

/**
 * The kit ships to adopters, so its own failure mode is a framework concern: a
 * policy whose `loadUri` reports every sample absent skips the agreement
 * assertion on every one of them, and the suite reports all-green having
 * checked nothing. Driving the kit through recording hooks is the only way to
 * observe which of the tests it EMITS pass — running it with the real runner
 * would just report the whole file green either way.
 */
describe('documentUriPolicyConformance — the suite it emits', () => {
   interface EmittedTest {
      name: string;
      run(): void;
   }

   function emit(makePolicy: () => DocumentUriPolicy, options?: { sampleUris?: readonly string[] }): EmittedTest[] {
      const emitted: EmittedTest[] = [];
      documentUriPolicyConformance(
         {
            describe: (_name, body) => body(),
            it: (name, body) => emitted.push({ name, run: body }),
            expect: (actual: unknown) => ({
               toBe(expected: unknown): void {
                  if (!Object.is(actual, expected)) {
                     throw new Error(`expected ${String(actual)} to be ${String(expected)}`);
                  }
               }
            })
         },
         'probe',
         makePolicy,
         options
      );
      return emitted;
   }

   function failingNames(tests: readonly EmittedTest[]): string[] {
      return tests
         .filter(test => {
            try {
               test.run();
               return false;
            } catch {
               return true;
            }
         })
         .map(test => test.name);
   }

   /** An existence-aware policy for which nothing on the sample list exists. */
   const nothingExists = (): DocumentUriPolicy =>
      new RealpathDocumentUriPolicy(
         makeNoopSharedServices({ workspace: { FileSystemProvider: { realpath: (): URI | undefined => undefined } } })
      );

   it('fails when an existence-aware policy resolves none of its samples', () => {
      // Exactly the adopter shape: a realpath-style policy plus the default
      // samples, which are four fictional paths.
      const emitted = emit(nothingExists);

      expect(emitted.length).toBeGreaterThan(0);
      expect(failingNames(emitted)).toEqual([expect.stringContaining('at least one sample URI is loadable')]);
   });

   it('passes the guard as soon as one sample resolves', () => {
      const oneExists = (): DocumentUriPolicy =>
         new RealpathDocumentUriPolicy(
            makeNoopSharedServices({
               workspace: {
                  FileSystemProvider: {
                     realpath: (uri: URI): URI | undefined => (uri.toString() === 'file:///real/x.fake' ? uri : undefined)
                  }
               }
            })
         );

      expect(failingNames(emit(oneExists, { sampleUris: ['file:///real/x.fake', 'file:///gone/y.fake'] }))).toEqual([]);
   });
});
