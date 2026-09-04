/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { CanonicalUri } from '@hydranium/protocol';
import type { ApplyWorkspaceEditResult } from 'vscode-languageserver';
import { Disposable } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { LANGUAGE_CLIENT_ID } from '../documents/client-ids.js';
import type { ClientTextDocumentChangeEvent, HydraniumTextDocuments } from '../documents/hydranium-text-documents.js';

/** Snapshot of an open document tracked by the stub. */
export interface StubTextDocumentEntry {
   uri: string;
   version: number;
   text: string;
   clientId: string;
}

/**
 * Stub for {@link HydraniumTextDocuments}. Implements the slice production code
 * reads from on test paths — the content channel
 * (`notifyDidChangeTextDocument` / `applyContentChange` / `version` /
 * `getAuthor`), the open-state probes (`isOpenInLanguageClient` /
 * `isOpenInAnyClient` / `openDocuments`), the push channel to the language
 * client (`applyEditToLanguageClient` / `stagePendingContent`) and the
 * save / close notifications — plus test-only helpers:
 *
 * - {@link seedOpen} — pre-populate an open document without firing change
 *   events. Use to set up a baseline version before exercising an `update`.
 * - {@link fireClose} — synchronously deliver `onDidClose` to subscribers.
 *   The `ModelService.onClientClosed` pass-through depends on this.
 * - {@link changes} / {@link saves} — replay arrays for assertion.
 *
 * # Stub-vs-real surface
 *
 * Picked methods are bound structurally to {@link HydraniumTextDocuments} via
 * `Pick<...>` so the compiler enforces that each picked signature stays in
 * lockstep with the real class. A standalone interface with no structural tie
 * lets the stub drift silently when the real manager grows a method: the
 * failure then surfaces only when a test calls the missing method at runtime.
 *
 * `get(uri)` is deliberately NOT picked — real returns the full
 * vscode-languageserver `TextDocument` (with `lineCount`, `positionAt`,
 * etc.); the stub returns just `{ version, getText }` which is the only
 * shape framework callers (`AstDocumentManager.save`) read on the test
 * paths. Promote to a Pick when a test needs the full document surface.
 *
 * Versions: {@link notifyDidChangeTextDocument} drops payloads whose version
 * is `<=` the current version (matches the real `HydraniumTextDocuments`
 * staleness fallback for clients with no didOpen baseline) so
 * concurrent-update test patterns observe the same supersession behaviour.
 * {@link applyContentChange} mirrors the real server-assigned write path:
 * the version steps iff the text differs from the current content.
 */
export interface StubHydraniumTextDocuments extends Pick<
   HydraniumTextDocuments<TextDocument>,
   | 'version'
   | 'notifyDidChangeTextDocument'
   | 'applyContentChange'
   | 'getAuthor'
   | 'isOpenInLanguageClient'
   | 'isOpenInAnyClient'
   | 'applyEditToLanguageClient'
   | 'stagePendingContent'
   | 'openDocuments'
> {
   /**
    * Stub-tailored read accessor. Returns just the surface the framework's
    * save path reads (`version` + `getText()`), rather than the real `get`'s
    * full `TextDocument`.
    */
   get(uri: string): { version: number; getText(): string } | undefined;
   /**
    * Stub-tailored save notification. Real signature accepts
    * `DidSaveTextDocumentParams` with optional `text`; the stub takes the
    * same shape but with `clientId` required (tests always supply it
    * explicitly).
    */
   notifyDidSaveTextDocument(event: { textDocument: { uri: string }; text?: string }, clientId: string): void;
   /** Stub-friendly save subscription — listener gets `{ document: { uri }, clientId }`. */
   onDidSave(listener: (event: { document: { uri: string }; clientId: string }) => void): Disposable;
   /** Real-shaped close subscription — listener gets {@link ClientTextDocumentChangeEvent}. */
   onDidClose(listener: (event: ClientTextDocumentChangeEvent<TextDocument>) => void): Disposable;
   /** Pre-populate an open document without firing change events. */
   seedOpen(uri: string, text: string, clientId: string): void;
   /** Mark `uri` as open in the LSP textual language client (drives {@link isOpenInLanguageClient}). */
   seedOpenInLanguageClient(uri: string): void;
   /** Synchronously deliver `onDidClose` to subscribers. */
   fireClose(uri: string, clientId: string): void;
   /** Drop recorded state. Useful for `beforeEach` resets. */
   reset(): void;
   readonly changes: readonly StubTextDocumentEntry[];
   readonly saves: readonly { uri: string; clientId: string }[];
   /**
    * Decide what {@link applyEditToLanguageClient} answers, so a suite can drive
    * the rejection path (`{ applied: false }`) the real client takes when its
    * buffer has outrun the version the push was addressed at. The call is still
    * recorded in {@link appliedEdits} either way. Defaults to accepting.
    *
    * The handler runs INSIDE the call, which is also the only place a suite can
    * simulate something happening while the push is in flight — a newer settle,
    * a concurrent client edit.
    */
   setApplyEditHandler(handler: (uri: string, text: string) => ApplyWorkspaceEditResult | undefined): void;
   /** Replay of every {@link applyEditToLanguageClient} call (the text channel to Monaco). */
   readonly appliedEdits: readonly { uri: string; text: string; label?: string }[];
   /** Replay of every {@link stagePendingContent} call (the not-yet-open staging path). */
   readonly staged: readonly { uri: string; text: string }[];
}

/** Build a {@link StubHydraniumTextDocuments}. */
export function makeStubHydraniumTextDocuments(): StubHydraniumTextDocuments {
   const docs = new Map<string, StubTextDocumentEntry>();
   const changes: StubTextDocumentEntry[] = [];
   const saves: { uri: string; clientId: string }[] = [];
   const languageClientOpen = new Set<string>();
   const appliedEdits: { uri: string; text: string; label?: string }[] = [];
   const staged: { uri: string; text: string }[] = [];
   let applyEditHandler: (uri: string, text: string) => ApplyWorkspaceEditResult | undefined = () => ({ applied: true });
   const saveListeners: Array<(event: { document: { uri: string }; clientId: string }) => void> = [];
   const closeListeners: Array<(event: ClientTextDocumentChangeEvent<TextDocument>) => void> = [];

   return {
      get changes() {
         return changes;
      },
      get saves() {
         return saves;
      },
      get appliedEdits() {
         return appliedEdits;
      },
      get staged() {
         return staged;
      },
      get(uri) {
         const doc = docs.get(uri);
         return doc ? { version: doc.version, getText: () => doc.text } : undefined;
      },
      version(uri) {
         return docs.get(uri)?.version ?? 0;
      },
      notifyDidChangeTextDocument(event, clientId = LANGUAGE_CLIENT_ID) {
         const existing = docs.get(event.textDocument.uri);
         const next: StubTextDocumentEntry = {
            uri: event.textDocument.uri,
            version: event.textDocument.version,
            text: event.contentChanges[0]?.text ?? '',
            clientId
         };
         if (existing && next.version <= existing.version) {
            return;
         }
         docs.set(event.textDocument.uri, next);
         changes.push(next);
      },
      applyContentChange(uri, text, clientId) {
         const existing = docs.get(uri);
         if (!existing) {
            throw new Error(`Document ${uri} is not open for content changes`);
         }
         const changed = existing.text !== text;
         // Mirrors the real store: step the version iff the content changed;
         // an identical write mints no new version (the original author stays
         // on record) but is still recorded as a change (rebuild fires).
         const next: StubTextDocumentEntry = changed ? { uri, version: existing.version + 1, text, clientId } : existing;
         docs.set(uri, next);
         changes.push({ uri, version: next.version, text, clientId });
         return next.version;
      },
      notifyDidSaveTextDocument(event, clientId) {
         saves.push({ uri: event.textDocument.uri, clientId });
         for (const listener of saveListeners.slice()) {
            listener({ document: { uri: event.textDocument.uri }, clientId });
         }
      },
      onDidSave(listener) {
         saveListeners.push(listener);
         return Disposable.create(() => {
            const idx = saveListeners.indexOf(listener);
            if (idx >= 0) {
               saveListeners.splice(idx, 1);
            }
         });
      },
      onDidClose(listener) {
         closeListeners.push(listener);
         return Disposable.create(() => {
            const idx = closeListeners.indexOf(listener);
            if (idx >= 0) {
               closeListeners.splice(idx, 1);
            }
         });
      },
      getAuthor(uri) {
         return docs.get(uri)?.clientId;
      },
      isOpenInLanguageClient(uri) {
         return languageClientOpen.has(uri);
      },
      isOpenInAnyClient(uri) {
         return docs.has(uri) || languageClientOpen.has(uri);
      },
      openDocuments() {
         // Merge the two seeding channels: `seedOpen` records the holding client
         // on the doc entry, `seedOpenInLanguageClient` marks the LSP client.
         const clientsByUri = new Map<string, Set<string>>();
         for (const [uri, entry] of docs) {
            clientsByUri.set(uri, new Set([entry.clientId]));
         }
         for (const uri of languageClientOpen) {
            const clients = clientsByUri.get(uri) ?? new Set<string>();
            clients.add(LANGUAGE_CLIENT_ID);
            clientsByUri.set(uri, clients);
         }
         // The real store keys by canonical identity; the stub's plain-string
         // keys stand in for it (single stub-boundary cast, like `fireClose`).
         return [...clientsByUri].map(([uri, clients]) => ({ uri: uri as CanonicalUri, clients: [...clients] }));
      },
      setApplyEditHandler(handler) {
         applyEditHandler = handler;
      },
      async applyEditToLanguageClient(uri, newText, options): Promise<ApplyWorkspaceEditResult | undefined> {
         appliedEdits.push({ uri, text: newText, label: options?.label });
         return applyEditHandler(uri, newText);
      },
      stagePendingContent(uri, text) {
         staged.push({ uri, text });
      },
      seedOpen(uri, text, clientId) {
         docs.set(uri, { uri, version: 1, text, clientId });
      },
      seedOpenInLanguageClient(uri) {
         languageClientOpen.add(uri);
      },
      fireClose(uri, clientId) {
         // Drop the closing client's hold BEFORE notifying, matching the real
         // class: listeners detect the last-close transition by consulting
         // `isOpenInAnyClient`, which reads the already-decremented state.
         const holder = docs.get(uri);
         if (holder && holder.clientId === clientId) {
            docs.delete(uri);
         }
         if (clientId === LANGUAGE_CLIENT_ID) {
            languageClientOpen.delete(uri);
         }
         const event = { document: { uri } as unknown as TextDocument, clientId } as ClientTextDocumentChangeEvent<TextDocument>;
         for (const listener of closeListeners.slice()) {
            listener(event);
         }
      },
      reset() {
         docs.clear();
         changes.length = 0;
         saves.length = 0;
         languageClientOpen.clear();
         appliedEdits.length = 0;
         staged.length = 0;
         saveListeners.length = 0;
         closeListeners.length = 0;
         applyEditHandler = () => ({ applied: true });
      }
   };
}
