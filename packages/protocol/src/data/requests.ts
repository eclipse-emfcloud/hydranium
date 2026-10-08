/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { BaseVersion } from '../model-service/base-version';

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
 * Update a document the session `clientId` has open. Generic over `TTransfer`
 * so adopters parameterise the structured shape against their grammar's
 * transfer-model overlay; passing a string is always allowed.
 */
export interface TransferUpdateDocumentArgs<TTransfer> {
   /** Document URI. */
   uri: string;
   /** The id of a live session registered on this connection. */
   clientId: string;
   /** The whole structured model root, or its serialised textual form. */
   model: TTransfer | string;
   /**
    * What this write was authored against. A `ModelVersion` is compared
    * against the server's current text-document version for `uri` and throws
    * `ConflictError` on mismatch; `'any'` writes unconditionally.
    *
    * **Required so that an ungated write is a decision rather than an
    * omission.** An optional gate is indistinguishable from a forgotten one at
    * the call site, and a file of twenty writes hides the one that lost the
    * field. Nothing else here can see that, since the defect is an absence.
    */
   baseVersion: BaseVersion;
}

/** Update a document the session `clientId` has open, then persist it to disk. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- save names its own args; it adds no field to update's
export interface TransferSaveDocumentArgs<TTransfer> extends TransferUpdateDocumentArgs<TTransfer> {}

/** Persist the text the server holds for a document the session `clientId` has open, without writing a model. */
export type TransferPersistDocumentArgs = Omit<TransferUpdateDocumentArgs<never>, 'model'>;

/** Register a client session on the connection. */
export interface CreateSessionArgs {
   /** The session's id, minted by the client; unique in the server process while the session is live. */
   clientId: string;
   /** What the participant is; kept as the server session's `label`. */
   label?: string;
   /**
    * A token the client keeps for the session's lifetime. It is no secret: the
    * wire carries no authentication. A later `createSession` for the same id
    * carrying the same token, from any connection, ends the session it names
    * and registers the id afresh, so a client whose connection dropped before
    * the server noticed can register again. Without it the id stays refused
    * until the server notices.
    */
   resumeToken?: string;
}

/** End a client session registered on the connection. */
export interface CloseSessionArgs {
   clientId: string;
}

/** Create a document that exists nowhere yet, open for the session creating it. */
export interface CreateModelDocumentArgs {
   uri: string;
   /** The id of a live session registered on this connection. */
   clientId: string;
   /** The document's initial content; it reaches disk with the first save. */
   text: string;
}

/**
 * Write several documents a session has open, all or none. `clientId` is on
 * the set rather than on each update: an id per update would allow a set
 * mixing clients, which the server would have to refuse.
 */
export interface TransferUpdateDocumentsArgs<TTransfer> {
   /** The id of a live session registered on this connection. */
   clientId: string;
   updates: Omit<TransferUpdateDocumentArgs<TTransfer>, 'clientId'>[];
}

/**
 * Identifies a per-document watch on the data server. Shared by both
 * `watchModelDocument` and `unwatchModelDocument` — the `(uri, clientId)`
 * pair is the watch key, so unwatching names the same watch that was
 * started. The `clientId` identifies the originator the same way it does
 * on the document writes (`TransferUpdateDocumentArgs.clientId`,
 * `TransferSaveDocumentArgs.clientId`): it keys the per-`(uri, clientId)`
 * watch bucket so multiple watchers on the same wire stay distinct, AND it lets
 * each watcher recognise its own echo on inbound `onDocumentUpdated` events
 * (the wire shape's `sourceClientId` carries the originating mutation's
 * `clientId`).
 */
export interface WatchModelDocumentArgs {
   uri: string;
   /** Stable identifier for the watching client. */
   clientId: string;
}
