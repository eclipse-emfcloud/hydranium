/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferDiagnostic } from './transfer-diagnostic';
import type { TransferElement } from './transfer-element';
import { asModelVersion, type ModelVersion, type TextVersion } from './model-service/base-version';

/** The model a data server built for a document, encoded for the wire. */
export interface TransferModelSnapshot<TRoot extends TransferElement, TDiagnostic = TransferDiagnostic> {
   root: TRoot;
   /** Absent until the document is validated; `[]` once it is and nothing was found. */
   diagnostics?: TDiagnostic[];
   /**
    * The version of the text `root` was parsed from. A caller that mutates the
    * model sends this back as the `baseVersion` of its write, and the server
    * rejects the write with `ConflictError` once its text has moved past it.
    */
   version: ModelVersion;
   /**
    * The data server's fingerprint of `root` and `diagnostics`, or under its
    * `'text-diagnostics'` strategy of the text `root` was parsed from and
    * `diagnostics`.
    * Independent of `version`; an equal hash also means equally validated.
    */
   hash: string;
}

/** The text a data server held for a document when it sent it. */
export interface TextState {
   /**
    * The server's version of that text. A `TransferModelSnapshot.version` below it
    * means the model was parsed from older text, and an update at this version
    * or a later one follows.
    */
   version: TextVersion;
   /**
    * What `textHash` makes of the text alone: equal texts hash equal whatever
    * their version or dirty state, across a revert or a server restart that
    * numbers versions afresh.
    */
   hash: string;
   /**
    * Whether the text differs from the file, as the server last knew the file.
    * A later change arrives as `onDocumentDirtyChanged` to a client watching
    * the document.
    */
   dirty: boolean;
}

/**
 * Wire envelope exchanged between the model-server's data-server head and
 * its clients: the server's model of a document and the text it holds for it,
 * each absent where the server has none.
 *
 * The constraint `TTransfer extends TransferElement` pins the type system
 * to the wire data shape (no `$container` cycles, references as strings;
 * see {@link TransferElement}).
 */
export interface TransferDocument<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic> {
   /** Need not be spelled as the request named it. */
   uri: string;
   /**
    * Absent when the document does not exist: the server answers an unknown
    * URI with a shaped envelope rather than an error, so absence is an
    * ordinary branch and not a catch.
    */
   model?: TransferModelSnapshot<TTransfer, TDiagnostic>;
   /** Absent when the server holds no text for the document. */
   text?: TextState;
}

/**
 * A {@link TransferDocument} the server actually had, so `model` is present.
 * Narrowed to by {@link TransferDocument.isLoaded} / {@link TransferDocument.assertLoaded}.
 */
export type LoadedTransferDocument<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic> = TransferDocument<
   TTransfer,
   TDiagnostic
> & {
   model: TransferModelSnapshot<TTransfer, TDiagnostic>;
};

/**
 * What a save or a persist answers: the document, and in `persisted` the
 * version of the text it wrote to the file. That can differ from
 * `model.version` either way, since writes land between the build and the
 * take, so a client marking a version saved takes it from here.
 */
export type TransferSavedDocument<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic> = TransferDocument<
   TTransfer,
   TDiagnostic
> & {
   persisted: { version: TextVersion };
};

/**
 * What a create answers: the document as a read after the create finds it,
 * and in `created` the version the create's text took. Another client's write
 * or an integrity repair can land between the create and that read, so
 * `model.version` can be past it, and a write based on it would carry that
 * text as the creator's; a write based on `created.version` conflicts instead.
 * A model version, not a text version, because the creator holds the text at
 * that version: it sent it.
 */
export type TransferCreatedDocument<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic> = TransferDocument<
   TTransfer,
   TDiagnostic
> & {
   created: { version: ModelVersion };
};

/** What a watch answers, once it is in place. */
export interface TransferWatchedDocument {
   /** The key the watch's events name the document by, which need not be the spelling the watch was asked with. */
   readonly uri: string;
   /** Whether a document exists there; one the server fails to load counts, only a missing one does not. */
   readonly exists: boolean;
   /** The position of the last update or deletion event sent before `exists` was taken; an event past it was sent after. */
   readonly sequence: number;
   /** The text the server held when `exists` was taken, as a read answers it; absent when it held none. */
   readonly text?: TextState;
}

export namespace TransferDocument {
   /**
    * Whether the server had this document. Branch on it where absence is an
    * ordinary state — a view bound to a file that may not exist yet.
    */
   export function isLoaded<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic>(
      document: TransferDocument<TTransfer, TDiagnostic>
   ): document is LoadedTransferDocument<TTransfer, TDiagnostic> {
      return document.model !== undefined;
   }

   /**
    * The same document with `model` no longer optional, or a throw. For call
    * sites where absence is a bug rather than a branch; the whole envelope is
    * returned because a caller needing `model` usually needs `uri` or `text`
    * with it.
    */
   export function assertLoaded<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic>(
      document: TransferDocument<TTransfer, TDiagnostic>
   ): LoadedTransferDocument<TTransfer, TDiagnostic> {
      if (!isLoaded(document)) {
         throw new Error(`No document at ${document.uri}`);
      }
      return document;
   }

   /** The envelope for a document the server does not have. */
   export function absent<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic>(
      uri: string
   ): TransferDocument<TTransfer, TDiagnostic> {
      return { uri };
   }

   /**
    * Construct a {@link TransferDocument} envelope with a model, its version
    * marked as coming from a read. `diagnostics` absent means not validated.
    */
   export function create<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic>(
      uri: string,
      version: number,
      root: TTransfer,
      hash: string,
      diagnostics?: TDiagnostic[],
      text?: TextState
   ): TransferDocument<TTransfer, TDiagnostic> {
      return {
         uri,
         model: { root, version: asModelVersion(version), hash, ...(diagnostics === undefined ? {} : { diagnostics }) },
         ...(text === undefined ? {} : { text })
      };
   }
}
