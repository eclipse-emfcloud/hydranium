/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Argument shapes for the in-process `ModelService` facade — the
 * canonical home for the lifecycle operation signatures. Implementation
 * lives in `@hydranium/core/langium/model-service`; this protocol
 * package owns the types so wire-side projections (the data-server
 * protocol in `./data`) can structurally extend them rather than
 * mirroring them by hand.
 *
 * `./model-server.ts` re-exports them, so an import from either path
 * resolves.
 */

/** Identifies a client-document binding. Every facade operation carries these fields. */
export interface TransferClientArgs {
   /** Document URI. */
   uri: string;
   /** Stable identifier for the client invoking the operation. */
   clientId: string;
}

/**
 * Update a document's content via the in-process facade. `model` may be
 * the structured (transfer-model or AST) root or its serialised textual
 * form — implementations decide which is faster on their transport.
 * Generic over `T` so adopters parameterise the structured shape against
 * their grammar's transfer-model overlay; passing a string is always
 * allowed.
 */
export interface TransferUpdateArgs<T> extends TransferClientArgs {
   /** Structured model root or its serialised textual form. */
   model: T | string;
   /**
    * Optional based-on version: the text-document version this update
    * was authored against. When set, the server compares against its
    * current text-document version for `uri` and throws
    * `ConflictError` on mismatch. Omit to opt out of the gate — mirrors
    * LSP's `OptionalVersionedTextDocumentIdentifier` posture, intended
    * for headless / CLI / batch tooling without a meaningful based-on
    * version.
    */
   baseVersion?: number;
}

/**
 * Persist a document to disk via the in-process facade. Same `model`
 * shape as {@link TransferUpdateArgs}.
 */
export interface TransferSaveArgs<T> extends TransferClientArgs {
   /** Structured model root or its serialised textual form. */
   model: T | string;
   /**
    * Optional based-on version — same semantics as
    * {@link TransferUpdateArgs.baseVersion}. `save` delegates the gating
    * check to its inner `update`, so this field threads through to the
    * same `ConflictError` site.
    */
   baseVersion?: number;
}
