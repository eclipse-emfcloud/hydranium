/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, type TextState } from '@hydranium/protocol';
import { Emitter, type Event } from 'vscode-languageserver';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { type TextLedger } from './text-ledger.js';

/** Delivered by the store's `onDidChangeDirty`, which forwards {@link DirtyStateTracker.onDidChangeDirty}. */
export interface DocumentDirtyChangedEvent {
   readonly uri: CanonicalUri;
   /**
    * The text the new answer of {@link DirtyStateTracker.isDirty} was decided
    * on. The answer changes with the text, before any build, so it can name
    * text whose model has not been sent yet. Absent when the document no longer
    * exists, or when the build that follows its release failed.
    */
   readonly text?: TextState;
}

/**
 * Owed by a document released dirty: the announcement that it is clean. A
 * first open before it is made takes it over, and each release owes one of its
 * own, so announcing for an earlier release cannot announce a later one clean.
 */
export interface CleanAnnouncement {
   /** Whether it is still owed: neither made nor taken over. */
   isOwed(): boolean;
   /** Make it, naming `text`; a no-op once it is no longer owed. */
   announce(text?: TextState): void;
}

/**
 * Whether each tracked document differs from its disk baseline: what the
 * server last knew the file to hold. The store reports every change of its
 * text and of the baseline; this decides the answer and announces it when it
 * changes.
 */
export interface DirtyStateTracker {
   readonly onDidChangeDirty: Event<DocumentDirtyChangedEvent>;
   /** `false` for a document not tracked. */
   isDirty(key: CanonicalUri): boolean;
   /**
    * Track `key` from its first open, holding `document`, while its file
    * holds `diskText`. Takes over the clean announcement a release still owes, so its
    * own answer decides the flip.
    */
   track(key: CanonicalUri, document: TextDocument, diskText: string | undefined): void;
   /** The text of `key` is now `document`'s. A no-op for a document not tracked. */
   refreshDirty(key: CanonicalUri, document: TextDocument): void;
   /** The file behind `key` holds `text`, `undefined` for none. A no-op for a document not tracked. */
   setDiskBaseline(key: CanonicalUri, document: TextDocument, text: string | undefined): void;
   /**
    * The store released `key`. Answers the clean announcement a document
    * released dirty now owes; `undefined` for one released clean.
    */
   release(key: CanonicalUri): CleanAnnouncement | undefined;
}

export class DefaultDirtyStateTracker implements DirtyStateTracker {
   protected readonly states = new Map<CanonicalUri, { baseline: string | undefined; dirty: boolean }>();
   /** Per document released dirty, the token of the announcement it owes. */
   protected readonly owedClean = new Map<CanonicalUri, object>();
   protected readonly dirtyChangedEmitter = new Emitter<DocumentDirtyChangedEvent>();

   /** @param textLedger hashes the text an announcement names. */
   constructor(protected readonly textLedger: TextLedger) {}

   get onDidChangeDirty(): Event<DocumentDirtyChangedEvent> {
      return this.dirtyChangedEmitter.event;
   }

   isDirty(key: CanonicalUri): boolean {
      return this.states.get(key)?.dirty ?? false;
   }

   track(key: CanonicalUri, document: TextDocument, diskText: string | undefined): void {
      this.states.set(key, { baseline: diskText, dirty: this.owedClean.delete(key) });
      this.refreshDirty(key, document);
   }

   refreshDirty(key: CanonicalUri, document: TextDocument): void {
      const state = this.states.get(key);
      if (!state) {
         return;
      }
      const dirty = document.getText() !== state.baseline;
      if (dirty !== state.dirty) {
         state.dirty = dirty;
         this.dirtyChangedEmitter.fire(
            Object.freeze({ uri: key, text: { version: document.version, hash: this.textLedger.hashOf(document), dirty } })
         );
      }
   }

   setDiskBaseline(key: CanonicalUri, document: TextDocument, text: string | undefined): void {
      const state = this.states.get(key);
      if (!state) {
         return;
      }
      state.baseline = text;
      this.refreshDirty(key, document);
   }

   release(key: CanonicalUri): CleanAnnouncement | undefined {
      const dirty = this.states.get(key)?.dirty;
      this.states.delete(key);
      if (!dirty) {
         return undefined;
      }
      const token = {};
      this.owedClean.set(key, token);
      const isOwed = (): boolean => this.owedClean.get(key) === token;
      return {
         isOwed,
         announce: text => {
            if (isOwed()) {
               this.owedClean.delete(key);
               this.dirtyChangedEmitter.fire(Object.freeze(text ? { uri: key, text } : { uri: key }));
            }
         }
      };
   }
}
