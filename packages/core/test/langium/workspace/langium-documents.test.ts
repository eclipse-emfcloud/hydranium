/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumDocument, OperationCancelled, URI } from '@hydranium/langium';
import type { ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { DefaultDocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import { HydraniumLangiumDocuments } from '../../../src/langium/workspace/langium-documents.js';
import { makeFakeAstNode, makeFakeDocument, makeNoopSharedServices } from '../../../src/testing/index.js';

const TARGET = URI.parse('file:///ws/a.txt');

interface HarnessOptions {
   /** What the document factory rejects with. Defaults to a bare provider-style miss. */
   readonly failWith?: unknown;
   /** `false` binds a policy that reports no loadable URI, as a realpath policy does for an absent path. */
   readonly loadable?: boolean;
   /** Register a document from inside the failing load, modelling a lost create race. */
   readonly raceInsert?: boolean;
}

interface Harness {
   readonly documents: HydraniumLangiumDocuments;
   /** URIs the factory was asked to load, so a test can prove whether a read was attempted. */
   readonly loads: string[];
   /** URIs parsed from empty text. Empty means no document was fabricated. */
   readonly fabricated: string[];
   /** Documents passed to `CstResidencyService.rehydrate`. */
   readonly rehydrated: LangiumDocument<AstNode>[];
}

/** Reports every URI unloadable, the answer a realpath policy gives for an absent path. */
class UnloadableUriPolicy extends DefaultDocumentUriPolicy {
   override loadUri(): URI | undefined {
      return undefined;
   }
}

function harness(options: HarnessOptions = {}): Harness {
   const loads: string[] = [];
   const fabricated: string[] = [];
   const rehydrated: LangiumDocument<AstNode>[] = [];
   // The racing factory registers into the instance it is wired to, so the slot
   // has to close over a holder filled after construction.
   const wired: { instance?: HydraniumLangiumDocuments } = {};

   const services = makeNoopSharedServices<ServerSharedServicesMinimal>({
      workspace: {
         DocumentUriPolicy: options.loadable === false ? new UnloadableUriPolicy() : new DefaultDocumentUriPolicy(),
         CstResidencyService: { rehydrate: (document: LangiumDocument<AstNode>) => rehydrated.push(document) },
         LangiumDocumentFactory: {
            fromString: (text: string, uri: URI) => {
               fabricated.push(uri.toString());
               return makeFakeDocument(uri, makeFakeAstNode<AstNode>({ $type: 'Parsed', text }));
            },
            fromUri: async (uri: URI) => {
               loads.push(uri.toString());
               if (options.raceInsert) {
                  wired.instance?.addDocument(makeFakeDocument(uri, makeFakeAstNode<AstNode>({ $type: 'Raced' })));
               }
               throw options.failWith ?? new Error(`No such file: ${uri.toString()}`);
            }
         }
      }
   });
   const documents = new HydraniumLangiumDocuments(services);
   wired.instance = documents;
   return { documents, loads, fabricated, rehydrated };
}

describe('HydraniumLangiumDocuments.getOrCreateDocument on a failed load', () => {
   it('propagates the read failure when the file is absent', async () => {
      const absent = new Error('ENOENT: no such file or directory');
      const { documents, loads } = harness({ failWith: absent });

      // An empty AST validates clean, so answering with one would hand the
      // caller a document that silently is not the file.
      await expect(documents.getOrCreateDocument(TARGET)).rejects.toBe(absent);
      expect(loads).toEqual([TARGET.toString()]);
      expect(documents.getDocument(TARGET)).toBeUndefined();
   });

   it('propagates the read failure when the file is present but unreadable', async () => {
      const unreadable = new Error('EACCES: permission denied');
      const { documents } = harness({ failWith: unreadable });

      // Carries the reason rather than flattening every miss to one message.
      await expect(documents.getOrCreateDocument(TARGET)).rejects.toBe(unreadable);
   });

   it('propagates cancellation rather than reporting a missing file', async () => {
      const { documents } = harness({ failWith: OperationCancelled });

      // The build relies on cancellation reaching whoever requested it.
      await expect(documents.getOrCreateDocument(TARGET)).rejects.toBe(OperationCancelled);
   });

   it('rejects without a read when the seam reports no loadable URI', async () => {
      const { documents, loads } = harness({ loadable: false });

      await expect(documents.getOrCreateDocument(TARGET)).rejects.toThrow(/No loadable content/);
      // The seam already answered, so nothing should reach the filesystem.
      expect(loads).toEqual([]);
   });

   it('fabricates nothing, so a caller that asked to load never gets a stand-in', async () => {
      const { documents, fabricated } = harness();

      // Swallow the rejection deliberately: that it rejects is pinned above, and
      // asserting it here would shadow this test's own claim.
      await documents.getOrCreateDocument(TARGET).catch(() => undefined);

      // The distinction the class documents: `createEmptyDocument` exists for a
      // caller that ASKS for a stand-in, and a failed load is not that caller.
      expect(fabricated).toEqual([]);
   });

   it('returns the concurrently created document rather than propagating', async () => {
      // Pins the ordering: a lost create race is resolved before the failure
      // propagates, so a race is not reported as a missing file.
      const { documents, rehydrated } = harness({ raceInsert: true });

      const document = await documents.getOrCreateDocument(TARGET);

      expect(document.parseResult.value.$type).toBe('Raced');
      expect(rehydrated).toEqual([document]);
   });
});

describe('HydraniumLangiumDocuments.createEmptyDocument', () => {
   it('parses empty text with the grammar the URI routes to', () => {
      const { documents, fabricated } = harness();

      const document = documents.createEmptyDocument(TARGET);

      expect(fabricated).toEqual([TARGET.toString()]);
      expect(document.parseResult.value.$type).toBe('Parsed');
   });

   it('does not register what it builds', () => {
      const { documents } = harness();

      documents.createEmptyDocument(TARGET);

      // A stand-in must not mask the real document once it appears.
      expect(documents.getDocument(TARGET)).toBeUndefined();
   });
});
