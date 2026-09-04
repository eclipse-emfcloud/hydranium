/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferDiagnostic } from '../transfer-diagnostic';
import type { TransferElement } from '../transfer-element';
import type { Project } from '../project';
import type { TransferDocument } from '../transfer-document';

/**
 * Why an update event fired. Subscribers filter on reason for behaviour
 * decisions (e.g. dirty-flag handling, undo-history grouping, telemetry):
 *
 * - `'changed'` — the URI appeared in `DocumentBuilder.onUpdate`'s
 *   `changed` list. The framework's underlying primitive is "this URI was
 *   passed to `documentBuilder.update(changed, deleted)`", which spans
 *   `didChange` text-document events, `notifyDidChangeTextDocument` calls,
 *   and any programmatic `documentBuilder.update([uri], [])` invocation.
 *   The name matches Langium's own `changed` parameter — it's vague-on-
 *   purpose because the underlying primitive is.
 * - `'rebuilt'` — the URI was rebuilt as a cascade from another URI's
 *   build (dependency graph re-derivation), without itself being passed to
 *   `documentBuilder.update`. The complement of `'changed'`.
 * - `'saved'` — emitted by adopters that synthesise a unified update stream
 *   from both `onDocumentUpdated` and `onDocumentSaved`. The framework's own
 *   `dispatchPhaseEvent` does NOT emit `'saved'` — saves take the dedicated
 *   `DataClientProtocol.onDocumentSaved` channel.
 * - `'deleted'` — the URI appeared in `DocumentBuilder.onUpdate`'s
 *   `deleted` list. The backing file was removed.
 */
export type TransferDocumentUpdateReason = 'changed' | 'rebuilt' | 'saved' | 'deleted';

/**
 * Delivered on the data-server when a document's content (or existence)
 * changed. Subscribers receive this via `DocumentServerProtocol.watchModelDocument`.
 *
 * The `document` field carries the latest built state — diagnostics + root
 * are coherent with each other at the time the event fired.
 */
export interface TransferDocumentUpdatedEvent<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> {
   document: TransferDocument<TTransfer, TDiagnostic>;
   /** Stable identifier of the client that triggered the update. */
   sourceClientId: string;
   reason: TransferDocumentUpdateReason;
}

/** Callback shape for `DataClientProtocol.onDocumentUpdated`. */
export type TransferDocumentUpdatedListener<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> = (event: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>) => void;

/**
 * Delivered on the data-server when a document was persisted to disk via
 * `DataServerProtocol.saveModelDocument`. Distinct from
 * {@link TransferDocumentUpdatedEvent}: subscribers that only care about
 * persistence (external sync, editor "saved" indicators, dirty-flag
 * clear) listen for this event family instead of filtering an update
 * stream for `reason: 'saved'`.
 *
 * The `document` field carries the post-save built state — same shape
 * the synchronous `saveModelDocument` RPC response returns, delivered
 * to subscribers (`DataClientProtocol.onDocumentSaved`) so non-caller
 * clients see the persistence event too.
 */
export interface TransferDocumentSavedEvent<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> {
   document: TransferDocument<TTransfer, TDiagnostic>;
   /**
    * The client whose `saveModelDocument` call produced this. Every subscriber
    * receives the event including the originator, which already had the same
    * state as the RPC response — compare against your own id to drop the echo
    * rather than re-rendering from it.
    */
   sourceClientId: string;
}

/** Callback shape for `DataClientProtocol.onDocumentSaved`. */
export type TransferDocumentSavedListener<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> = (event: TransferDocumentSavedEvent<TTransfer, TDiagnostic>) => void;

/**
 * Why a project-change event fired. `added` — the project was newly
 * registered (descriptor discovered); `updated` — the project's
 * descriptor content changed and its registry entry was refreshed
 * (same id, possibly different version / dependencies / adopter-specific
 * fields); `removed` — the project's descriptor disappeared and the
 * registry entry was dropped.
 */
export type ProjectChangeReason = 'added' | 'updated' | 'removed';

/**
 * Delivered on the data-server when a project's lifecycle state changed
 * (added / updated / removed in the registry). Subscribers receive this
 * via `DataClientProtocol.onProjectsChanged`.
 *
 * Granularity is one event per affected project: an internal registry
 * diff with three additions and one removal fans out to four wire
 * notifications. This matches the typical client-side pattern of "react
 * to one project at a time" (refresh a tree entry, update a tab badge,
 * etc.) without forcing clients to walk arrays.
 *
 * For `reason: 'removed'`, the carried {@link project} is the pre-removal
 * snapshot — by the time the event fires, the registry has already
 * cleared the entry, so clients that need the removed project's metadata
 * (id, version, dependencies, adopter-specific fields) read it here
 * instead of maintaining their own snapshot.
 */
export interface ProjectsChangedEvent<TProject extends Project = Project> {
   readonly project: TProject;
   readonly reason: ProjectChangeReason;
}

/** Callback shape for `DataClientProtocol.onProjectsChanged`. */
export type ProjectsChangedListener<TProject extends Project = Project> = (event: ProjectsChangedEvent<TProject>) => void;
