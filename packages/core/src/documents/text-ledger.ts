/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, type TextVersion, textHash } from '@hydranium/protocol';
import { type TextDocument } from 'vscode-languageserver-textdocument';

/** What {@link TextLedger} holds for a document: where its version sequence stands, kept across closes and reopens. */
export interface TextRecord {
   readonly version: TextVersion;
   /** {@link textHash} of the text at that version. */
   readonly hash: string;
}

/**
 * Where each document's {@link TextVersion} sequence stands, and who authored
 * each version; the text-side counterpart of `ModelLedger`.
 *
 * A record survives the document's release and is never pruned, not even when
 * the file is deleted: a sequence that restarts lets a write based on the old
 * text pass the base-version gate. Authors last only until the release.
 */
export interface TextLedger {
   /**
    * The version a first open of `key` with `text` starts at: the record's
    * version when the text is unchanged, one step on when it changed;
    * `undefined` without a record.
    */
   openingVersion(key: CanonicalUri, text: string): TextVersion | undefined;
   /** Keep where the sequence of the released `document` stands. */
   record(key: CanonicalUri, document: TextDocument): void;
   recordOf(key: CanonicalUri): TextRecord | undefined;
   /**
    * Text reached the closed document `key` outside the store's write paths.
    * Steps the record iff `text` differs from it, and starts one at `0` when
    * there is none.
    */
   reconcile(key: CanonicalUri, text: string): TextVersion;
   /** {@link textHash} of `document`'s text, taken once per version. */
   hashOf(document: TextDocument): string;
   setAuthor(key: CanonicalUri, version: TextVersion, author: string): void;
   /** The author of `version`, or of the latest version when `version` is omitted. */
   authorOf(key: CanonicalUri, version?: TextVersion): string | undefined;
   clearAuthors(key: CanonicalUri): void;
}

export class DefaultTextLedger implements TextLedger {
   protected readonly records = new Map<CanonicalUri, TextRecord>();
   protected readonly authors = new Map<CanonicalUri, string[]>();
   protected readonly hashes = new WeakMap<TextDocument, { readonly version: number; readonly hash: string }>();

   openingVersion(key: CanonicalUri, text: string): TextVersion | undefined {
      const recorded = this.records.get(key);
      if (recorded === undefined) {
         return undefined;
      }
      return recorded.hash === textHash(text) ? recorded.version : recorded.version + 1;
   }

   record(key: CanonicalUri, document: TextDocument): void {
      this.records.set(key, { version: document.version, hash: this.hashOf(document) });
   }

   recordOf(key: CanonicalUri): TextRecord | undefined {
      return this.records.get(key);
   }

   reconcile(key: CanonicalUri, text: string): TextVersion {
      const hash = textHash(text);
      const recorded = this.records.get(key);
      if (recorded?.hash === hash) {
         return recorded.version;
      }
      const version = recorded === undefined ? 0 : recorded.version + 1;
      this.records.set(key, { version, hash });
      return version;
   }

   hashOf(document: TextDocument): string {
      const taken = this.hashes.get(document);
      if (taken?.version === document.version) {
         return taken.hash;
      }
      const hash = textHash(document.getText());
      this.hashes.set(document, { version: document.version, hash });
      return hash;
   }

   setAuthor(key: CanonicalUri, version: TextVersion, author: string): void {
      let history = this.authors.get(key);
      if (!history) {
         history = [];
         this.authors.set(key, history);
      }
      history[version] = author;
   }

   authorOf(key: CanonicalUri, version?: TextVersion): string | undefined {
      const history = this.authors.get(key);
      // `!== undefined` so version 0 is not read as "latest".
      return version !== undefined ? history?.[version] : history?.at(-1);
   }

   clearAuthors(key: CanonicalUri): void {
      this.authors.delete(key);
   }
}
