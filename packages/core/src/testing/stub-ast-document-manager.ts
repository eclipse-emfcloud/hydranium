/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, type LangiumDocument, UriUtils } from '@hydranium/langium';
import { Disposable } from 'vscode-languageserver';
import { type AstDiagnostic } from '../langium/validation/document-validator.js';
import { AstDocument, type AstDocumentManager, type UpdateAttribution } from '../documents/ast-document-manager.js';
import { type WritableFileSystemProvider } from '../langium/workspace/file-system-provider.js';
import { UNKNOWN_CLIENT_ID } from '../documents/client-ids.js';
import { DefaultModelLedger, type ModelLedger } from '../documents/model-ledger.js';
import { type CloseModelArgs, type OpenModelArgs } from '@hydranium/protocol';
import type { StubHydraniumTextDocuments } from './stub-hydranium-text-documents.js';
import type { StubLangiumDocuments } from './stub-langium-documents.js';

/**
 * Minimal stub of {@link AstDocumentManager} for use in test harnesses,
 * implementing what the model service and client sessions call. `getAuthor`
 * throws if invoked, and `attributeUpdate` reports every update as its
 * author's change; tests that need either should wire a richer stub or use
 * the real {@link AstDocumentManager}.
 *
 * Open state is tracked per URI as the set of holding client ids, so a
 * document stays open until its last client closes. The stub forwards
 * content-change / save notifications to the supplied
 * {@link StubHydraniumTextDocuments} so assertions on its `changes` /
 * `saves` arrays see the same traffic the real manager would produce.
 *
 * # Stub-vs-real surface
 *
 * Picks the methods the stub claims to implement from
 * {@link AstDocumentManager} — the compiler enforces each signature
 * stays aligned with the real class. Methods that throw `notSupported`
 * are still picked so signature drift on them produces a compile
 * error rather than silent divergence.
 */
export interface StubAstDocumentManager<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> extends Pick<
   AstDocumentManager<TAst, TDiagnostic>,
   'open' | 'close' | 'isOpen' | 'update' | 'save' | 'getAuthor' | 'getDocument' | 'toAstDocument' | 'attributeUpdate'
> {
   readonly openClients: Map<string, Set<string>>;
}

export function makeStubAstDocumentManager<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic>(
   textDocuments: StubHydraniumTextDocuments,
   fileSystem: Pick<WritableFileSystemProvider, 'writeFile'>,
   documents?: StubLangiumDocuments<TAst, TDiagnostic>,
   ledger: ModelLedger = new DefaultModelLedger()
): StubAstDocumentManager<TAst, TDiagnostic> {
   const openClients = new Map<string, Set<string>>();
   const notSupported = (method: string): never => {
      throw new Error(`StubAstDocumentManager.${method} is not implemented; wire the real AstDocumentManager if your test needs it.`);
   };
   const close = async (args: CloseModelArgs): Promise<void> => {
      const clients = openClients.get(args.uri);
      clients?.delete(args.clientId);
      if (clients && clients.size === 0) {
         openClients.delete(args.uri);
      }
   };
   return {
      openClients,
      async open(args: OpenModelArgs): Promise<Disposable> {
         const clients = openClients.get(args.uri) ?? new Set<string>();
         clients.add(args.clientId);
         openClients.set(args.uri, clients);
         // The real `open` materialises the synced document (from the payload
         // text or the filesystem), or attaches the client to the one that is
         // there; mirror both so a subsequent `update` finds the document open
         // for this client.
         if (!textDocuments.get(args.uri)) {
            textDocuments.seedOpen(args.uri, args.text ?? '', args.clientId);
         } else {
            textDocuments.attachClient(args.uri, args.clientId);
         }
         return Disposable.create(() => close({ uri: args.uri, clientId: args.clientId }));
      },
      close,
      isOpen(uri: string): boolean {
         return openClients.has(uri);
      },
      async update(uri: string, text: string, clientId: string): Promise<number> {
         // Mirrors the real manager: the store assigns the shared version
         // (step iff the content changed) — no fabricated version numbers.
         return textDocuments.applyContentChange(uri, text, clientId);
      },
      async save(uri: string, clientId: string): Promise<number> {
         const text = textDocuments.get(uri)?.getText() ?? '';
         const version = textDocuments.version(uri);
         await fileSystem.writeFile(UriUtils.toUri(uri), text);
         textDocuments.notifyDidSaveTextDocument({ textDocument: { uri }, text }, clientId);
         return version;
      },
      getAuthor(): string {
         return notSupported('getAuthor');
      },
      // Reports every event as a change by the version's author: the stub
      // tree runs no builds, so there is no delivery to tell a rebuild by. A
      // test of the rebuilt branch replaces this method or uses the real
      // manager.
      attributeUpdate(document: LangiumDocument): UpdateAttribution {
         const author = textDocuments.getAuthor(document.textDocument.uri, document.textDocument.version) ?? UNKNOWN_CLIENT_ID;
         return { reason: 'changed', sourceClientId: author, causedBy: author };
      },
      // Canonicalizing document gateway. The stub has no canonicalizer, so it looks
      // the document up in the seeded `StubLangiumDocuments` by its given URI (tests
      // that need real symlink canonicalization wire the real AstDocumentManager).
      getDocument(uri: string): LangiumDocument | undefined {
         return documents?.getDocument(UriUtils.toUri(uri));
      },
      toAstDocument(document: LangiumDocument): AstDocument<TAst, TDiagnostic> {
         const uri = document.textDocument.uri;
         const root = document.parseResult.value as TAst;
         return AstDocument.create<TAst, TDiagnostic>(uri, ledger.versionOf(root), root, document.diagnostics as TDiagnostic[] | undefined);
      }
   };
}
