/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferSaveArgs, TransferUpdateArgs } from '../model-service/args';

/** Get the current state of a single document. The server returns the latest built version. */
export interface GetModelDocumentArgs {
   /** Document URI. */
   uri: string;
   /**
    * When `true`, the response is settled at the validation phase so its
    * `diagnostics` are populated. When `false`/absent, the response returns at
    * the (faster) integrity-settled phase and `diagnostics` may be absent —
    * they are computed asynchronously and delivered via the subscription
    * channel (and, for an LSP head, `publishDiagnostics`).
    *
    * Set this for one-shot / unsubscribed callers (CLI queries, batch checks)
    * that need diagnostics in the response itself. Mirrors Langium's
    * `BuildOptions.validation: boolean`. Note it does not *strip* diagnostics:
    * a document already validated still carries them; the flag only controls
    * whether the read forces/awaits validation.
    */
   includeDiagnostics?: boolean;
}

/**
 * Look up the project owning the given document URI. Membership semantics
 * are decided by the server's `ProjectManager` (default in
 * `AbstractProjectManager`: closest-ancestor descriptor folder); the data-
 * server forwards the URI without interpretation.
 */
export interface GetProjectForUriArgs {
   /** Document URI to look up. */
   uri: string;
}

/**
 * Update a document's content. Wire-side projection of the facade's
 * {@link TransferUpdateArgs}; structurally identical so the data-server RPC
 * handler can forward straight to the in-process `ModelService.update`
 * without an args mapping.
 */
export type TransferUpdateDocumentArgs<TTransfer> = TransferUpdateArgs<TTransfer>;

/** Persist a document to disk. Wire-side projection of {@link TransferSaveArgs}. */
export type TransferSaveDocumentArgs<TTransfer> = TransferSaveArgs<TTransfer>;

/**
 * Identifies a per-document watch on the data server. Shared by both
 * `watchModelDocument` and `unwatchModelDocument` — the `(uri, clientId)`
 * pair is the watch key, so unwatching names the same watch that was
 * started. The `clientId` identifies the originator the same way it does
 * on facade-side mutations (`TransferUpdateArgs.clientId`,
 * `TransferSaveArgs.clientId`): it keys the per-`(uri, clientId)` watch
 * bucket so multiple watchers on the same wire stay distinct, AND it lets
 * each watcher recognise its own echo on inbound `onDocumentUpdated` events
 * (the wire shape's `sourceClientId` carries the originating mutation's
 * `clientId`).
 */
export interface WatchModelDocumentArgs {
   uri: string;
   /** Stable identifier for the watching client. */
   clientId: string;
}
