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
import type { TextState, TransferDocument } from '../transfer-document';

/**
 * Why an update event fired. Subscribers filter on reason for behaviour
 * decisions (e.g. dirty-flag handling, undo-history grouping, telemetry):
 *
 * - `'changed'` — the server's first update event for the document's current
 *   version: its content changed since the last one. A write whose build a
 *   later write cancelled is still `'changed'` in the build that takes over.
 * - `'rebuilt'` — a later event for a version the server already delivered,
 *   whether or not any client watched it then: something the document depends
 *   on changed, or the document was built again with the same content. The
 *   complement of `'changed'`.
 * - `'saved'` — emitted by adopters that synthesise a unified update stream
 *   from both `onDocumentUpdated` and `onDocumentSaved`. The framework's own
 *   `dispatchPhaseEvent` does NOT emit `'saved'` — saves take the dedicated
 *   `DataClientProtocol.onDocumentSaved` channel.
 *
 * The version rule needs a version the server keeps and builds that validate.
 * For a document no client has opened, or when rebuilds do not validate,
 * `'changed'` means the URI was passed to `DocumentBuilder.update` for this
 * build. A document that a validating build skips is `'changed'` every time.
 *
 * Deletion is deliberately NOT a member. An update event carries a built
 * document, which a deleted one has none of, and the phase-driven path that
 * produces these events never runs for a deleted URI — the builder drops the
 * document before deriving the rebuild set. It travels as
 * {@link TransferDocumentDeletedEvent} on its own channel instead.
 */
export type TransferDocumentUpdateReason = 'changed' | 'rebuilt' | 'saved';

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
   /**
    * The client whose write this event echoes: the author of the version on a
    * `'changed'`, and the unknown-client id on a `'rebuilt'`, which echoes no
    * write. A recipient compares it against its own id to recognise its echo.
    * The build that follows a document's release names the release id
    * instead.
    */
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
 * `DataServerProtocol.saveModelDocument` or `persistModelDocument`. Distinct
 * from {@link TransferDocumentUpdatedEvent}: subscribers that only care about
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
    * The client whose `saveModelDocument` or `persistModelDocument` call
    * produced this, also when another client wrote the persisted text. Every
    * subscriber receives the event including the originator, which already had
    * the same state as the RPC response — compare against your own id to drop
    * the echo rather than re-rendering from it.
    */
   sourceClientId: string;
}

/** Callback shape for `DataClientProtocol.onDocumentSaved`. */
export type TransferDocumentSavedListener<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> = (event: TransferDocumentSavedEvent<TTransfer, TDiagnostic>) => void;

/**
 * Delivered on the data-server when a watched document's text starts or stops
 * differing from its file, as the server last knew the file. The current
 * answer rides on every transfer document the server sends as `text.dirty`;
 * this carries only its changes, so a client that follows it needs no rebuild
 * to learn of a save.
 */
export interface TransferDocumentDirtyChangedEvent {
   /** Canonical URI, keyed as the subscription is. */
   readonly uri: string;
   /**
    * The text the answer was decided on. It is sent before that text is
    * built, so a `text.version` ahead of the model a client holds means an
    * update at this version or a later one follows. Absent when the document
    * no longer exists, or when the build that follows its release failed.
    */
   readonly text?: TextState;
}

/** Callback shape for `DataClientProtocol.onDocumentDirtyChanged`. */
export type TransferDocumentDirtyChangedListener = (event: TransferDocumentDirtyChangedEvent) => void;

/**
 * Delivered on the data-server when a document's backing file was removed.
 * Carries no document, and cannot: the state a
 * {@link TransferDocumentUpdatedEvent} would have to carry no longer exists by
 * the time anyone can be told. That is also why deletion is not a `reason` on
 * the update stream — `DocumentBuilder.update` drops the document before
 * deriving the rebuild set, so the phase-driven path that produces update
 * events never runs for it.
 *
 * **Delivered for EVERY document, not only watched ones**, unlike
 * `onDocumentUpdated` and `onDocumentSaved`. The test that decides which
 * channels are gated is whether any OTHER source can observe the fact on the
 * least capable host: a browser-hosted client's workspace lives behind the
 * head, so nothing there can see a file disappear, and gating the notification
 * would leave it blind. (A Theia frontend's filesystem watcher would cover it,
 * which is why this is a host argument and not a structure-versus-content one.)
 * A watcher is told about its own document's deletion here too, the update
 * channel being silent for deletions by construction. Filter on {@link uri} if
 * the receiver only cares about documents it opened.
 *
 * A watch survives the deletion, so a file that comes back resumes delivering
 * `onDocumentUpdated` to the same subscribers with no re-subscription. A
 * client that responds by closing its editor releases the watch through
 * `closeModelDocument` as usual.
 */
export interface TransferDocumentDeletedEvent {
   /** Canonical URI of the removed document, keyed as the subscription is. */
   readonly uri: string;
}

/** Callback shape for `DataClientProtocol.onDocumentDeleted`. */
export type TransferDocumentDeletedListener = (event: TransferDocumentDeletedEvent) => void;

/**
 * Delivered on the data-server once per build, naming the documents that reached
 * the configured subscription phase (`DataServerOptions.subscriptionPhase`,
 * `Validated` by default) and that NO client on the connection is watching. Not
 * the integrity-settled landmark, which is a different point and a different
 * word in this framework.
 *
 * The complement of {@link TransferDocumentUpdatedEvent}, which is gated per
 * URI: together the two cover every document a build touched. This one exists
 * for the case no source outside the server can observe — a document rebuilt
 * because something it DEPENDS ON changed. Its own file never changed, so a
 * filesystem watcher cannot see it, and it has no subscriber, so the update
 * channel does not report it. A consumer showing data derived from such a
 * document (a tree label, a decorator) would otherwise hold a stale value with
 * nothing to invalidate it.
 *
 * Carries URIs and no documents: a recipient re-reads what it displays, through
 * `getModelDocument` or its own request. That keeps the bandwidth property the
 * per-URI subscription exists for, without gating the message.
 *
 * Not sent when the set is empty, which is the normal case while editing — the
 * document being edited is watched by its own editor and therefore excluded.
 * Workspace initialisation sends nothing either: it does not build to the
 * subscription phase. The largest message a workspace can produce is therefore
 * a whole-workspace rebuild at that phase, which is one message of URIs.
 */
export interface TransferDocumentsBuiltEvent {
   /** Canonical URIs, keyed as subscriptions are. Never empty. */
   readonly uris: readonly string[];
}

/** Callback shape for `DataClientProtocol.onDocumentsBuilt`. */
export type TransferDocumentsBuiltListener = (event: TransferDocumentsBuiltEvent) => void;

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
