/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { asCanonicalUri } from '@hydranium/protocol';
import { UriUtils } from '@hydranium/langium';
import { type DocumentUriPolicy } from '../langium/workspace/document-uri-policy.js';

/**
 * The runner primitives the suite emits through. Vitest and Jest both supply
 * structurally-compatible `describe`/`it`/`expect`, so the kit takes them as a
 * parameter rather than importing a runner — keeping it usable from either, and
 * keeping `@hydranium/core/testing` free of a hard runner dependency (the
 * barrel is consumed by Jest adopters too).
 */
export interface DocumentUriPolicyConformanceHooks {
   describe(name: string, body: () => void): void;
   it(name: string, body: () => void): void;
   expect(actual: unknown): { toBe(expected: unknown): void };
}

/** Options for {@link documentUriPolicyConformance}. */
export interface DocumentUriPolicyConformanceOptions {
   /**
    * URIs the contract is checked against. A policy that strengthens identity
    * (realpath) should include a divergent (symlinked) and an absent sample so
    * the resolve / fallback branches are exercised. Defaults to a syntactic
    * spread (dot segments, spaces, a non-`file:` scheme) that any policy honours.
    */
   readonly sampleUris?: readonly string[];
}

const DEFAULT_SAMPLE_URIS = ['file:///a/b.fake', 'file:///a/../b.fake', 'file:///My Folder/x.fake', 'builtin:///Element.fake'];

/**
 * Reusable contract suite for any {@link DocumentUriPolicy} implementation —
 * the framework's `DefaultDocumentUriPolicy` / `RealpathDocumentUriPolicy` and
 * any adopter policy. Pins the two invariants the document-identity story
 * rests on, so a change to either method — or an adopter binding a
 * custom policy — cannot silently reintroduce the canonical/load divergence:
 *
 * 1. **`canonicalUri` is idempotent** — feeding it an already-canonical URI
 *    (e.g. a `LangiumDocument.uri` straight off the build) is a fixed point.
 * 2. **Present-case agreement** — whenever `loadUri(u)` is defined (the URI is
 *    loadable), its normalised form equals `canonicalUri(u)`. This is the
 *    "two methods, one policy" guarantee: the key the document is stored under
 *    and the URI it is loaded from must denote the same identity, or a
 *    subscriber keyed by one misses events delivered under the other.
 *
 * The miss case is deliberately NOT constrained (the default returns the URI
 * unchanged from `loadUri`; a realpath policy returns `undefined`) — only the
 * present case must agree.
 *
 * The agreement check is vacuous for a sample that is not loadable, so the
 * suite also emits a guard asserting that at least ONE sample is: an
 * existence-aware policy (realpath, or an adopter's) bound against the
 * fictional {@link DEFAULT_SAMPLE_URIS} resolves every one of them to
 * `undefined`, and would otherwise report an all-green suite that checked
 * nothing.
 *
 * @param hooks the test runner's `describe`/`it`/`expect`
 * @param suiteName label for the emitted `describe` block
 * @param makePolicy fresh policy per assertion (no shared mutable state)
 */
export function documentUriPolicyConformance(
   hooks: DocumentUriPolicyConformanceHooks,
   suiteName: string,
   makePolicy: () => DocumentUriPolicy,
   options: DocumentUriPolicyConformanceOptions = {}
): void {
   const { describe, it, expect } = hooks;
   const sampleUris = options.sampleUris ?? DEFAULT_SAMPLE_URIS;

   describe(suiteName, () => {
      for (const uri of sampleUris) {
         it(`canonicalUri is idempotent for ${uri}`, () => {
            const once = makePolicy().canonicalUri(uri);
            expect(makePolicy().canonicalUri(once)).toBe(once);
         });

         it(`canonicalUri agrees with loadUri when ${uri} is loadable`, () => {
            const policy = makePolicy();
            const loaded = policy.loadUri(uri);
            if (loaded === undefined) {
               return; // not loadable: the agreement invariant is vacuous here
            }
            expect(policy.canonicalUri(uri)).toBe(asCanonicalUri(UriUtils.normalize(loaded)));
         });
      }

      // Computed here rather than tallied from the assertions above, so the
      // guard does not depend on the runner executing tests in declaration
      // order (a `--shuffle` run would otherwise read it as zero).
      it(`at least one sample URI is loadable (checked: ${sampleUris.join(', ')})`, () => {
         const loadable = sampleUris.filter(uri => makePolicy().loadUri(uri) !== undefined);
         expect(loadable.length > 0).toBe(true);
      });
   });
}
