/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNodeDescription, stream, type Stream } from '@hydranium/langium';
import type { HydraniumIndexManager } from '../langium/workspace/index-manager.js';

/**
 * Stub for the framework's {@link HydraniumIndexManager}, backed by a flat list
 * of descriptions a test seeds directly. It stands in for the GLOBAL INDEX — the
 * source Langium's `DefaultScopeProvider.getGlobalScope` reads — so a test can
 * assert what a scope does and does not fall through to without a workspace,
 * a parse or a build.
 *
 * # Stub-vs-real surface
 *
 * `Pick` claims only the three read methods, so TypeScript keeps their
 * signatures in lockstep with the real class and every other member of it (the
 * `updateContent` / `removeContent` index maintenance, the reference index,
 * `resolveElement*`, `getElementsInProject`) is unreachable through this
 * interface. A test that needs one of those wants the real class over a real
 * workspace.
 *
 * `nodeType` filtering is an exact `type` match, NOT the reflection subtype test
 * the real manager applies — the stub binds no `AstReflection`. So a fixture
 * asserting subtype visibility must name the concrete type, or it is asserting
 * against the stub rather than against the framework.
 */
export interface StubIndexManager extends Pick<HydraniumIndexManager, 'allElements' | 'getElementsByName' | 'getElementByName'> {
   /** Mutable seed; push / splice to model an index changing between assertions. */
   readonly descriptions: AstNodeDescription[];
   /** Drop every seeded description. */
   reset(): void;
}

/** Build a {@link StubIndexManager}. Initial `descriptions` are pushed onto the mutable backing array. */
export function makeStubIndexManager(initialDescriptions: readonly AstNodeDescription[] = []): StubIndexManager {
   const descriptions: AstNodeDescription[] = [...initialDescriptions];

   const matching = (name: string, type?: string, languageId?: string): AstNodeDescription[] =>
      descriptions.filter(
         description =>
            description.name === name &&
            (type === undefined || description.type === type) &&
            // The real manager derives the language id from the document URI via
            // the service registry; the stub has neither, so it can only honour
            // an unfiltered query.
            languageId === undefined
      );

   return {
      get descriptions() {
         return descriptions;
      },
      allElements(nodeType?: string, uris?: Set<string>): Stream<AstNodeDescription> {
         return stream(
            descriptions.filter(
               description =>
                  (nodeType === undefined || description.type === nodeType) &&
                  (uris === undefined || uris.has(description.documentUri.toString()))
            )
         );
      },
      getElementsByName(name: string, type?: string, languageId?: string): readonly AstNodeDescription[] {
         return matching(name, type, languageId);
      },
      getElementByName(name: string, type?: string, languageId?: string): AstNodeDescription | undefined {
         return matching(name, type, languageId)[0];
      },
      reset() {
         descriptions.length = 0;
      }
   };
}
