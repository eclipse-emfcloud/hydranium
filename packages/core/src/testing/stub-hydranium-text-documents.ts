/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, textHash } from '@hydranium/protocol';
import type { ApplyWorkspaceEditResult } from 'vscode-languageserver';
import { Disposable, Emitter } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { LANGUAGE_CLIENT_ID } from '../documents/client-ids.js';
import { ClientSessionRegistry } from '../documents/client-session-registry.js';
import type {
   ClientTextDocumentChangeEvent,
   DocumentDirtyChangedEvent,
   HydraniumTextDocuments,
   LastOpenClosedEvent
} from '../documents/hydranium-text-documents.js';

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
 * `isOpenInAnyClient` / `isOpenInClient` / `isRevertPending` /
 * `openDocuments`), the push channel
 * to the language client (`applyEditToLanguageClient` / `stagePendingContent`),
 * the save / close notifications, the dirty state (`isDirty` / `textState` /
 * `onDidChangeDirty` / `updateDiskBaseline`, against a baseline {@link seedOpen}
 * sets and a save that carries its text moves), and the client-session table
 * (`registerSession` / `closeSession` / `onDidCloseSession`), which is a real
 * `ClientSessionRegistry` — plus test-only helpers:
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
   | 'isRevertPending'
   | 'applyEditToLanguageClient'
   | 'stagePendingContent'
   | 'openDocuments'
   | 'isOpenInClient'
   | 'attachClient'
   | 'registerSession'
   | 'closeSession'
   | 'onDidCloseSession'
   | 'onDidCloseLastOpen'
   | 'isDirty'
   | 'textState'
   | 'onDidChangeDirty'
   | 'updateDiskBaseline'
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
   /** Pre-populate an open document without firing change events; `text` is also its disk baseline. */
   seedOpen(uri: string, text: string, clientId: string): void;
   /** Mark `uri` as open in the LSP textual language client (drives {@link isOpenInLanguageClient}). */
   seedOpenInLanguageClient(uri: string): void;
   /**
    * Synchronously deliver `onDidClose` to subscribers, then `onDidCloseLastOpen`
    * when no client has `uri` open any more. The stub keeps no revert grace, so
    * a last close is announced at once.
    */
   fireClose(uri: string, clientId: string): void;
   /**
    * Drop recorded state. Useful for `beforeEach` resets.
    *
    * Sessions end without announcing it, so a model service built on this
    * stub still holds the handles it started before the reset. Build a fresh
    * service after a reset rather than reusing one across it.
    */
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
   // The real registry, so the session table, the opens and the closing state
   // behave as the store's do. The stub's plain-string keys
   // stand in for canonical URIs (one stub-boundary cast, like `fireClose`).
   const sessions = new ClientSessionRegistry();
   const key = (uri: string): CanonicalUri => uri as CanonicalUri;
   const lastOpenClosed = new Emitter<LastOpenClosedEvent>();
   const baselines = new Map<string, string | undefined>();
   const dirty = new Set<string>();
   const dirtyChanged = new Emitter<DocumentDirtyChangedEvent>();
   // As the real store: dirty while held with text other than the baseline,
   // announced only when the answer changes.
   const refreshDirty = (uri: string): void => {
      const held = docs.get(uri);
      const now = held !== undefined && held.text !== baselines.get(uri);
      if (now !== dirty.has(uri)) {
         if (now) {
            dirty.add(uri);
         } else {
            dirty.delete(uri);
         }
         dirtyChanged.fire({ uri: key(uri), text: { version: held?.version ?? 0, hash: textHash(held?.text ?? ''), dirty: now } });
      }
   };

   const stub: StubHydraniumTextDocuments = {
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
      textState(uri) {
         const held = docs.get(uri);
         return held && { version: held.version, hash: textHash(held.text), dirty: dirty.has(uri) };
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
         refreshDirty(event.textDocument.uri);
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
         refreshDirty(uri);
         return next.version;
      },
      notifyDidSaveTextDocument(event, clientId) {
         if (event.text !== undefined) {
            stub.updateDiskBaseline(event.textDocument.uri, event.text);
         }
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
      isOpenInClient(uri, clientId) {
         return sessions.isOpenIn(key(uri), clientId);
      },
      isRevertPending(uri) {
         return sessions.isRevertPending(key(uri));
      },
      attachClient(uri, clientId) {
         return docs.has(uri) && sessions.addOpen(key(uri), clientId);
      },
      registerSession(clientId) {
         sessions.register(clientId);
      },
      closeSession(clientId, cause) {
         if (!sessions.isRegistered(clientId)) {
            return;
         }
         try {
            for (const uri of sessions.beginClose(clientId)) {
               stub.fireClose(uri, clientId);
            }
         } finally {
            sessions.unregister(clientId, cause);
         }
      },
      get onDidCloseSession() {
         return sessions.onDidCloseSession;
      },
      get onDidCloseLastOpen() {
         return lastOpenClosed.event;
      },
      isDirty(uri) {
         return dirty.has(uri);
      },
      get onDidChangeDirty() {
         return dirtyChanged.event;
      },
      updateDiskBaseline(uri, text) {
         if (docs.has(uri)) {
            baselines.set(uri, text);
            refreshDirty(uri);
         }
      },
      openDocuments() {
         // From the registry that also answers `isOpenInClient`, which both
         // seeding channels feed, so the two never disagree about an open.
         return sessions.openDocuments();
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
         sessions.addOpen(key(uri), clientId);
         docs.set(uri, { uri, version: 1, text, clientId });
         baselines.set(uri, text);
      },
      seedOpenInLanguageClient(uri) {
         sessions.addOpen(key(uri), LANGUAGE_CLIENT_ID);
         languageClientOpen.add(uri);
      },
      fireClose(uri, clientId) {
         // Drop the closing client's hold BEFORE notifying, matching the real
         // class: listeners detect the last-close transition by consulting
         // `isOpenInAnyClient`, which reads the already-decremented state.
         const holder = docs.get(uri);
         if (holder && holder.clientId === clientId) {
            docs.delete(uri);
            refreshDirty(uri);
         }
         const removed = sessions.removeOpen(key(uri), clientId);
         if (clientId === LANGUAGE_CLIENT_ID) {
            languageClientOpen.delete(uri);
         }
         const event = { document: { uri } as unknown as TextDocument, clientId } as ClientTextDocumentChangeEvent<TextDocument>;
         for (const listener of closeListeners.slice()) {
            listener(event);
         }
         if (removed && !sessions.isOpen(key(uri))) {
            lastOpenClosed.fire({ uri: key(uri) });
         }
      },
      reset() {
         docs.clear();
         changes.length = 0;
         saves.length = 0;
         languageClientOpen.clear();
         appliedEdits.length = 0;
         staged.length = 0;
         baselines.clear();
         dirty.clear();
         saveListeners.length = 0;
         closeListeners.length = 0;
         applyEditHandler = () => ({ applied: true });
         // Cleared in place rather than replaced: a model service built on the
         // stub subscribed to `onDidCloseSession` once, and a new registry would
         // leave that subscription on one nothing fires.
         sessions.clear();
      }
   };
   return stub;
}
