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

import type { BasedOn } from './based-on';

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
    * What this update was authored against. A `SnapshotVersion` is compared
    * against the server's current text-document version for `uri` and throws
    * `ConflictError` on mismatch; `'anything'` writes unconditionally.
    *
    * **Required so that an ungated write is a decision rather than an
    * omission.** An optional gate is indistinguishable from a forgotten one at
    * the call site, and a file of twenty writes hides the one that lost the
    * field. Nothing else here can see that, since the defect is an absence.
    */
   basedOn: BasedOn;
}

/**
 * Persist a document to disk via the in-process facade. Same `model`
 * shape as {@link TransferUpdateArgs}.
 */
export interface TransferSaveArgs<T> extends TransferClientArgs {
   /** Structured model root or its serialised textual form. */
   model: T | string;
   /**
    * Same semantics and same requirement as {@link TransferUpdateArgs.basedOn}.
    * `save` delegates the gating check to its inner `update`, so this field
    * threads through to the same `ConflictError` site.
    */
   basedOn: BasedOn;
}
