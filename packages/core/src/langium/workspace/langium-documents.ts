/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, DefaultLangiumDocuments, type LangiumDocument, type LangiumDocuments, type URI } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { type DocumentUriPolicy } from './document-uri-policy.js';

/**
 * The registry surface the framework adds on top of Langium's
 * {@link LangiumDocuments}. Declared separately from the implementing class so
 * the shared-services slot can narrow to it: the class takes the services tree
 * as its constructor parameter, so naming the CLASS there would make that type
 * depend on itself.
 */
export interface HydraniumDocumentRegistry extends LangiumDocuments {
   createEmptyDocument(uri: URI): LangiumDocument<AstNode>;
}

/**
 * Default `LangiumDocuments` for `@hydranium/core` consumers, extending
 * Langium's {@link DefaultLangiumDocuments} with:
 *
 * 1. **Identity via the {@link DocumentUriPolicy} seam.**
 *    `getOrCreateDocument` resolves the requested URI through the seam — the
 *    same identity the text store and the AST-document event filters use — so
 *    an adopter that strengthens document identity (e.g. resolving symlinks to
 *    a real path) does so by binding the policy *once*, with no
 *    `LangiumDocuments` override. The default resolves to the URI unchanged
 *    (`DefaultDocumentUriPolicy`), matching Langium's own keying.
 *
 * 2. **A load that finds nothing rejects**, rather than answering with a
 *    transient empty document. An empty AST validates clean, so a placeholder
 *    hands the caller something that silently is not the file, and a caller
 *    that wants a document for a URI with no content on disk cannot use one
 *    anyway: it is unregistered, so no build, index or save can see it, and
 *    `LangiumDocumentFactory.update` reads from disk. Content that legitimately
 *    lives outside the filesystem belongs in a virtual document, which carries
 *    real source text.
 */
export class HydraniumLangiumDocuments extends DefaultLangiumDocuments implements HydraniumDocumentRegistry {
   /** Document-identity seam, shared with the text store, event filters, and builder. */
   protected readonly uriPolicy: DocumentUriPolicy;

   constructor(protected override readonly services: ServerSharedServicesMinimal) {
      super(services);
      this.uriPolicy = services.workspace.DocumentUriPolicy;
   }

   /**
    * Build a transient document for `uri` by parsing empty text with the
    * grammar `uri` routes to, so the root is that language's entry type with
    * every containment list initialised.
    *
    * For callers that need a document at a URI with no content on disk — the
    * scope provider querying before a file exists is the case it was added for.
    * `getOrCreateDocument` deliberately does NOT fall back to this: fabricating
    * a document behind a caller that asked to LOAD one hands back something
    * that silently is not the file, whereas calling this is a caller saying it
    * wants a stand-in.
    *
    * The result is not registered, so nothing downstream can see it, and
    * `LangiumDocumentFactory.update` would read from disk. It is a probe, not a
    * document under construction; content that must survive belongs in a
    * virtual document, which carries real source text.
    *
    * Building the root by hand instead needs the entry type name and a cast
    * past the generated types, and leaves those lists `undefined`. A grammar
    * whose entry rule opens with mandatory syntax yields a parse error here,
    * and it is kept: `AstReflection.isComplete` is `false` for such a root
    * however it is built, so the error states the same thing.
    */
   createEmptyDocument(uri: URI): LangiumDocument<AstNode> {
      // The two-argument overload is synchronous; passing a cancellation token
      // selects the promise-returning one, which this contract cannot await.
      return this.langiumDocumentFactory.fromString('', uri);
   }

   override async getOrCreateDocument(uri: URI): Promise<LangiumDocument<AstNode>> {
      const resolved = this.uriPolicy.loadUri(uri);
      if (resolved) {
         const existing = this.getDocument(resolved);
         if (existing) {
            // A registered document may have had its CST shed by a residency
            // policy. CST→AST readers that fetch it here — e.g. the call/type
            // hierarchy's `findDeclarationNodeAtOffset(root.$cstNode, …).astNode`
            // offset-scan — run no build, so restore the CST on demand. No-op
            // (and so behaviour-neutral) when the CST is resident.
            this.services.workspace.CstResidencyService.rehydrate(existing);
            return existing;
         }
         try {
            // Real on-disk content → Langium loads it and registers it.
            return await super.getOrCreateDocument(resolved);
         } catch (error: unknown) {
            // Load lost a race with a concurrent create — return that document.
            // Checked before propagating, so a race is not reported as a
            // missing file; cancellation carries no document and falls through.
            const reentrant = this.getDocument(resolved);
            if (reentrant) {
               this.services.workspace.CstResidencyService.rehydrate(reentrant);
               return reentrant;
            }
            throw error;
         }
      }
      // The seam reports no loadable content, so there is nothing to read and
      // no error from a read to carry.
      throw new Error(`No loadable content for ${uri.toString()}`);
   }
}
