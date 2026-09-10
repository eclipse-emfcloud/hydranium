/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, DefaultLangiumDocuments, type LangiumDocument, type LangiumDocuments, type URI } from '@hydranium/langium';
import { defineMessage } from '@hydranium/protocol';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { type DocumentUriPolicy } from './document-uri-policy.js';
import { type HydraniumLangiumDocumentFactory } from './hydranium-langium-document-factory.js';

/**
 * The document a caller asked to load is not there.
 *
 * User-facing, and the Node host's spelling of it: `loadUri` returns `undefined`
 * exactly when the URI policy's `realpath` reports the path absent. A host whose
 * provider has no `realpath` never reaches this — the miss surfaces from the
 * provider instead, so the same condition has one declaration per host.
 */
export const NO_LOADABLE_CONTENT = defineMessage('hydranium/core/no-loadable-content', 'No loadable content for {uri}');

/**
 * A stand-in was asked for at a URI that routes to no grammar, and no language
 * id was given to route it instead.
 *
 * User-facing, and raised BEFORE the parse: left to Langium's ladder the same
 * condition surfaces as `no services for the extension ''`, which names neither
 * the URI nor the argument that would have answered.
 */
export const NO_LANGUAGE_FOR_STAND_IN = defineMessage(
   'hydranium/core/no-language-for-stand-in',
   'No grammar routes {uri}; pass a languageId to say which one the stand-in should parse with'
);

/**
 * The registry surface the framework adds on top of Langium's
 * {@link LangiumDocuments}. Declared separately from the implementing class so
 * the shared-services slot can narrow to it: the class takes the services tree
 * as its constructor parameter, so naming the CLASS there would make that type
 * depend on itself.
 */
export interface HydraniumDocumentRegistry extends LangiumDocuments {
   createEmptyDocument(uri: URI, languageId?: string): LangiumDocument<AstNode>;
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

   /**
    * Narrows the inherited Langium factory field to the framework's, so the
    * language-explicit `fromStringInLanguage` below needs no cast. The
    * framework's shared module binds that class.
    */
   declare protected readonly langiumDocumentFactory: HydraniumLangiumDocumentFactory;

   constructor(protected override readonly services: ServerSharedServicesMinimal) {
      super(services);
      this.uriPolicy = services.workspace.DocumentUriPolicy;
   }

   /**
    * Build a transient document for `uri` by parsing empty text with the
    * grammar `languageId` names, or the one `uri` routes to when it is
    * omitted, so the root is that language's entry type with every containment
    * list initialised.
    *
    * For callers that need a document at a URI with no content on disk — the
    * scope provider querying before a file exists is the case it was added for.
    * `getOrCreateDocument` deliberately does NOT fall back to this: fabricating
    * a document behind a caller that asked to LOAD one hands back something
    * that silently is not the file, whereas calling this is a caller saying it
    * wants a stand-in.
    *
    * **Pass `languageId` whenever the URI names no file.** The create-element
    * flow this exists for asks at the DIRECTORY a file is about to be written
    * into, and a directory URI has no extension for the routing ladder to end
    * on — so omitting the id there fails inside the parse, on an empty
    * extension rather than on the URI. A caller in that position always knows
    * its language: {@link HydraniumScopeProvider} is bound per grammar, and a
    * request that names no document at all still carries the AST type
    * `ExtendedServiceRegistry.soleServicesByType` routes on.
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
   createEmptyDocument(uri: URI, languageId?: string): LangiumDocument<AstNode> {
      if (languageId !== undefined) {
         return this.langiumDocumentFactory.fromStringInLanguage('', uri, languageId);
      }
      if (!this.services.ServiceRegistry.getServicesFor(uri)) {
         // Reported here rather than left to the parse, which ends on the empty
         // extension and so names neither the URI nor the id that would have
         // answered.
         throw new Error(NO_LANGUAGE_FOR_STAND_IN.format({ uri: uri.toString() }));
      }
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
      throw new Error(NO_LOADABLE_CONTENT.format({ uri: uri.toString() }));
   }
}
