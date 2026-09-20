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
import { asSnapshotVersion, type SnapshotVersion } from './model-service/based-on';

/**
 * Wire envelope exchanged between the model-server's data-server head and
 * its clients. Carries a transfer-shaped root — never an AST root — plus
 * the document's diagnostics in the adopter's wire-diagnostic shape.
 *
 * The constraint `TTransfer extends TransferElement` pins the type system
 * to the wire data shape (no `$container` cycles, references as strings;
 * see {@link TransferElement}). The paired server-internal envelope is
 * `AstDocument<TAst extends AstNode, TDiagnostic>` in
 * `@hydranium/core` — same structural shape, different generic
 * constraint, used at the AST layer before the `TransferEncoder`
 * translation produces a {@link TransferDocument}.
 */
export interface TransferDocument<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic> {
   uri: string;
   /**
    * The document version this snapshot was taken at — sourced from the
    * server's text-document version counter. A caller that mutates the document
    * subsequently sends this straight back as `TransferUpdateArgs.basedOn` (or
    * `TransferSaveArgs.basedOn`), and the server rejects a stale-based update
    * with `ConflictError`.
    *
    * See `@hydranium/protocol#errors` for the conflict-detection contract.
    */
   version: SnapshotVersion;
   /**
    * Absent when the document does not exist — the server answers an unknown URI
    * with a shaped envelope rather than an error, so absence is an ordinary
    * branch and not a catch. Declared required it reads as a guarantee, and
    * every `root.x` compiles into a throw.
    */
   root?: TTransfer;
   diagnostics: TDiagnostic[];
}

/**
 * A {@link TransferDocument} the server actually had, so `root` is present.
 * Narrowed to by {@link TransferDocument.isLoaded} / {@link TransferDocument.assertLoaded}.
 */
export type LoadedTransferDocument<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic> = TransferDocument<
   TTransfer,
   TDiagnostic
> & {
   root: TTransfer;
};

export namespace TransferDocument {
   /**
    * Whether the server had this document. Branch on it where absence is an
    * ordinary state — a view bound to a file that may not exist yet.
    */
   export function isLoaded<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic>(
      document: TransferDocument<TTransfer, TDiagnostic>
   ): document is LoadedTransferDocument<TTransfer, TDiagnostic> {
      return document.root !== undefined;
   }

   /**
    * The same document with `root` no longer optional, or a throw. For call
    * sites where absence is a bug rather than a branch; the whole envelope is
    * returned because a caller needing `root` usually needs `uri` or `version`
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

   /**
    * The envelope for a document the server does not have — `root` absent, and
    * the version a read of a URI the store never saw reports.
    *
    * Exists so the absent branch is built the same way the present one is: both
    * doors mark the version as coming from a read, and neither asks a caller to
    * do it.
    */
   export function absent<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic>(
      uri: string,
      diagnostics: TDiagnostic[] = []
   ): TransferDocument<TTransfer, TDiagnostic> {
      return { uri, version: asSnapshotVersion(0), root: undefined, diagnostics };
   }

   /**
    * Construct a {@link TransferDocument} envelope. `diagnostics` defaults
    * to `[]` so test fixtures, fake protocol implementations, and the
    * "no diagnostics yet" code paths don't need to repeat the empty array
    * at every call site.
    */
   export function create<TTransfer extends TransferElement, TDiagnostic = TransferDiagnostic>(
      uri: string,
      version: number,
      root: TTransfer,
      diagnostics: TDiagnostic[] = []
   ): TransferDocument<TTransfer, TDiagnostic> {
      return { uri, version: asSnapshotVersion(version), root, diagnostics };
   }
}
