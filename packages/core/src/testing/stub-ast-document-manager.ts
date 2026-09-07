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
import {
   type AstDocument,
   type AstDocumentManager,
   type AstDocumentUpdatedEvent,
   type WritableFileSystemProvider
} from '../documents/ast-document-manager.js';
import type { CloseModelArgs, OpenModelArgs } from '@hydranium/protocol';
import type { StubHydraniumTextDocuments } from './stub-hydranium-text-documents.js';
import type { StubLangiumDocuments } from './stub-langium-documents.js';

/**
 * Minimal stub of {@link AstDocumentManager} for use in test
 * harnesses. Implements just the methods the framework's
 * `ModelService` calls (`open` / `close` / `update` / `save` /
 * `isOpen` / `getDocument`); `onSave` / `onClientClosed` forward to the
 * underlying stub text-document manager, `onUpdate` is driven explicitly
 * through {@link StubAstDocumentManager.emitUpdate} because the stub tree runs
 * no build phases to emit from, and the remaining read helpers
 * (`isDirectChange`, `getAuthor`, `readFile`) throw if invoked — tests that
 * need them should wire a richer stub or use the real
 * {@link AstDocumentManager}.
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
export interface StubAstDocumentManager<TAst extends AstNode, TDiagnostic = unknown> extends Pick<
   AstDocumentManager<TAst, TDiagnostic>,
   | 'open'
   | 'close'
   | 'isOpen'
   | 'update'
   | 'save'
   | 'onUpdate'
   | 'onSave'
   | 'onClientClosed'
   | 'getAuthor'
   | 'getDocument'
   | 'isDirectChange'
   | 'readFile'
> {
   readonly openClients: Map<string, Set<string>>;

   /**
    * Deliver an update event to every live {@link StubAstDocumentManager.onUpdate}
    * subscriber for `uri`. Returns how many listeners received it.
    *
    * **This exists because `onUpdate` cannot fire on its own, and that is a
    * trap without a driver.** The real manager emits from a
    * `DocumentBuilder.onDocumentPhase(Validated)` hook; a `makeTestServices`
    * tree has a stub builder that runs no phases, so a subscription made
    * through the stub would never be called. A test written as
    * `onUpdate(uri, …); await tick(); expect(events).toHaveLength(0)` therefore
    * passes for the wrong reason — the listener was never wired to anything —
    * and reads as coverage of a suppression path it never reached. Driving the
    * event explicitly is what lets such a test first prove delivery works, so
    * the negative assertion means something.
    *
    * **The return value is the point, not a convenience.** `0` says no
    * subscriber for that URI was registered, which is the state a negative
    * assertion cannot distinguish from correct suppression. Assert it is
    * non-zero before believing an empty event list.
    *
    * Two alternatives were rejected. Making `onUpdate` THROW would fence the
    * hazard at zero API cost, but this harness ships (`files: ["lib", "src"]`)
    * and an adopter subclass or test that subscribes and legitimately ignores
    * the event would start failing on a stub it never asked to fire. Wiring the
    * stub to the text-document store's change notifications — the way `onSave`
    * is wired — would make it fire on its own, which moves the pass reason of
    * every existing suite on a `makeTestServices` tree and asserts a phase
    * semantics (`Validated`, with the real manager's author lookup and
    * `changed`/`deleted`/`rebuilt` classification) that no stub tree has.
    */
   emitUpdate(uri: string, event: AstDocumentUpdatedEvent<TAst, TDiagnostic>): number;

   /**
    * How many live {@link StubAstDocumentManager.onUpdate} subscribers `uri`
    * has, or the total across every URI when called with no argument.
    *
    * Read from outside — it is what a test asserts to show a subscription was
    * actually established, and what makes {@link emitUpdate}'s `0` legible.
    */
   updateSubscriptions(uri?: string): number;
}

export function makeStubAstDocumentManager<TAst extends AstNode, TDiagnostic = unknown>(
   textDocuments: StubHydraniumTextDocuments,
   fileSystem: Pick<WritableFileSystemProvider, 'writeFile'>,
   documents?: StubLangiumDocuments<TAst, TDiagnostic>
): StubAstDocumentManager<TAst, TDiagnostic> {
   const openClients = new Map<string, Set<string>>();
   // Keyed by the URI as given, not canonicalized: the stub has no URI policy,
   // and `getDocument` below looks documents up by their given URI for the same
   // reason, so both halves agree on identity.
   const updateListeners = new Map<string, Set<(event: AstDocumentUpdatedEvent<TAst, TDiagnostic>) => void>>();
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
         // text or the filesystem); mirror that so a subsequent `update` finds
         // an open document to apply its content change to.
         if (!textDocuments.get(args.uri)) {
            textDocuments.seedOpen(args.uri, args.text ?? '', args.clientId);
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
      async save(uri: string, clientId: string): Promise<void> {
         const text = textDocuments.get(uri)?.getText() ?? '';
         await fileSystem.writeFile(UriUtils.toUri(uri), text);
         textDocuments.notifyDidSaveTextDocument({ textDocument: { uri }, text }, clientId);
      },
      // Registers the listener but never calls it by itself — the real manager
      // emits from a `DocumentBuilder.onDocumentPhase(Validated)` hook and the
      // stub tree runs no phases. `emitUpdate` is the only thing that fires it;
      // see its declaration for why that is a driver rather than a throw or an
      // autonomous wiring.
      onUpdate(uri: string, listener: (event: AstDocumentUpdatedEvent<TAst, TDiagnostic>) => void): Disposable {
         const listeners = updateListeners.get(uri) ?? new Set<(event: AstDocumentUpdatedEvent<TAst, TDiagnostic>) => void>();
         listeners.add(listener);
         updateListeners.set(uri, listeners);
         return Disposable.create(() => {
            listeners.delete(listener);
            if (listeners.size === 0) {
               updateListeners.delete(uri);
            }
         });
      },
      emitUpdate(uri: string, event: AstDocumentUpdatedEvent<TAst, TDiagnostic>): number {
         // Snapshot before iterating: a listener that disposes itself on first
         // delivery would otherwise mutate the set mid-iteration.
         const listeners = [...(updateListeners.get(uri) ?? [])];
         for (const listener of listeners) {
            listener(event);
         }
         return listeners.length;
      },
      updateSubscriptions(uri?: string): number {
         if (uri !== undefined) {
            return updateListeners.get(uri)?.size ?? 0;
         }
         let total = 0;
         for (const listeners of updateListeners.values()) {
            total += listeners.size;
         }
         return total;
      },
      onSave(uri: string, listener: (event: { document: AstDocument<TAst, TDiagnostic>; sourceClientId: string }) => void): Disposable {
         return textDocuments.onDidSave(event => {
            if (event.document.uri !== uri) {
               return;
            }
            listener({
               document: { uri, version: textDocuments.version(uri), root: undefined as unknown as TAst, diagnostics: [] as TDiagnostic[] },
               sourceClientId: event.clientId
            });
         });
      },
      onClientClosed(uri: string, clientId: string, listener: () => void): Disposable {
         return textDocuments.onDidClose(event => {
            if (event.clientId === clientId && event.document.uri === uri) {
               listener();
            }
         });
      },
      getAuthor(): string {
         return notSupported('getAuthor');
      },
      // Canonicalizing document gateway. The stub has no canonicalizer, so it looks
      // the document up in the seeded `StubLangiumDocuments` by its given URI (tests
      // that need real symlink canonicalization wire the real AstDocumentManager).
      getDocument(uri: string): LangiumDocument | undefined {
         return documents?.getDocument(UriUtils.toUri(uri));
      },
      isDirectChange(): boolean {
         return notSupported('isDirectChange');
      },
      async readFile(uri: string): Promise<string> {
         return notSupported(`readFile(${uri})`);
      }
   };
}
