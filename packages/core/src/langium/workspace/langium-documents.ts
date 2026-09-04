/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type AstNode, DefaultLangiumDocuments, type LangiumDocument, type URI } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { type DocumentUriPolicy } from './document-uri-policy.js';

/**
 * Default `LangiumDocuments` for `@hydranium/core` consumers. Layers two
 * extensions on top of Langium's {@link DefaultLangiumDocuments}:
 *
 * 1. **Identity via the {@link DocumentUriPolicy} seam.**
 *    `getOrCreateDocument` resolves the requested URI through the seam — the
 *    same identity the text store and the AST-document event filters use — so
 *    an adopter that strengthens document identity (e.g. resolving symlinks to
 *    a real path) does so by binding the policy *once*, with no
 *    `LangiumDocuments` override. The default resolves to the URI unchanged
 *    (`DefaultDocumentUriPolicy`), matching Langium's own keying.
 *
 * 2. **`createEmptyDocument(uri)` — synchronous** factory for a transient
 *    document with no loadable on-disk content. `getOrCreateDocument` falls
 *    back to it when the seam reports no loadable URI, or when `super` cannot
 *    load it, so callers always receive a document. Abstract because the
 *    parse-result root is grammar-specific (each grammar returns its own
 *    root node type). The fallback document is deliberately
 *    **not** registered: a transient placeholder must not mask the real
 *    document once it appears.
 */
export abstract class AbstractHydraniumLangiumDocuments extends DefaultLangiumDocuments {
   /** Document-identity seam, shared with the text store, event filters, and builder. */
   protected readonly uriPolicy: DocumentUriPolicy;
   protected readonly tracer: Tracer;

   constructor(protected override readonly services: ServerSharedServicesMinimal) {
      super(services);
      this.uriPolicy = services.workspace.DocumentUriPolicy;
      this.tracer = services.Tracer.for('LangiumDocuments');
   }

   /**
    * Build a transient empty document for `uri`. Implemented by consumers
    * because the parse-result root is grammar-specific.
    */
   abstract createEmptyDocument(uri: URI): LangiumDocument<AstNode>;

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
            const reentrant = this.getDocument(resolved);
            if (reentrant) {
               this.services.workspace.CstResidencyService.rehydrate(reentrant);
               return reentrant;
            }
            // No concurrent document, so the load genuinely failed. The fallback
            // below still runs, because the file-not-found case is the ordinary
            // one here and no provider-independent way to recognise it exists:
            // Node's provider throws `ENOENT`, the in-memory one a bare `Error`,
            // and the provider is a seam an adopter rebinds. Discriminating on
            // message text across that seam would be a worse defect than the
            // one it fixes. So the failure is TRACED rather than propagated —
            // an unreadable-but-present file still degrades to an empty
            // document, but it stops doing so silently.
            this.tracer
               .with(resolved.toString())
               .debug(`Load failed, falling back to an empty document: ${error instanceof Error ? error.message : String(error)}`);
         }
      }
      // No loadable content (missing / synthetic / not yet written): a transient
      // empty placeholder keyed canonically — not registered (see the class doc).
      return this.createEmptyDocument(resolved ?? uri);
   }
}
