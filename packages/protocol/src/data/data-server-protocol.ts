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
import type { CloseModelArgs, FindNextNameArgs, OpenModelArgs, ReferenceContext, ReferenceRequest } from '../model-server';
import type { ReferenceCandidate, ReferenceTarget } from '../model-service/reference-candidate';
import type { ProjectsChangedEvent, TransferDocumentSavedEvent, TransferDocumentUpdatedEvent } from './events';
import type {
   GetModelDocumentArgs,
   GetProjectForUriArgs,
   TransferSaveDocumentArgs,
   WatchModelDocumentArgs,
   TransferUpdateDocumentArgs
} from './requests';

/**
 * Document-scoped slice of the data-server wire contract: the per-document
 * lifecycle (get / update / save), the per-`(uri, clientId)` watch
 * pair, and the global `waitForReady` startup gate that callers await before
 * the first document request.
 *
 * Generic over the transfer root type (`TTransfer`) and the diagnostic
 * shape (`TDiagnostic`). `TTransfer extends TransferElement` constrains the
 * root to the wire data shape (no `$container` cycles, references as
 * strings — see `transfer-element.ts`) — the type-system bridge between the
 * data-server's protocol surface and the transfer-model overlay each adopter
 * declares.
 *
 * Composed into {@link DataServerProtocol} alongside {@link ProjectServerProtocol};
 * a pure single-document consumer can compose only this fragment.
 */
export interface DocumentServerProtocol<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic> {
   /**
    * Open a document for an editor session and return its current state.
    * Registers `(uri, clientId)` with the multi-client document manager
    * (so concurrent editors share one built document) and returns the
    * document at the server's configured target phase — the same shape
    * {@link getModelDocument} returns, except that `version` is taken from
    * the text-document store so the caller's first `baseVersion` write
    * cannot self-conflict. Idempotent in registration terms: opening an
    * already-open document refreshes the client registration. Note it does
    * NOT avoid a rebuild — a second client attaching triggers
    * `refreshContent`, which fires a change event, so mounting a form on a
    * document already open in a text editor rebuilds it.
    *
    * The default `DataServer` impl delegates to `ModelService.open` then
    * reads the built state. Pair with {@link watchModelDocument} to receive
    * subsequent build-phase events (open returns a one-shot snapshot;
    * later validation diagnostics arrive on the watch channel).
    */
   openModelDocument(args: OpenModelArgs): Promise<TransferDocument<TTransfer, TDiagnostic>>;

   /**
    * Close an editor session for `(uri, clientId)`. Counterpart to
    * {@link openModelDocument}; the underlying document stays built until
    * every registered client has closed. The default `DataServer` impl
    * delegates to `ModelService.close` and ALSO releases any watch for the
    * same `(uri, clientId)` (closing a session frees its own watch — a
    * forgotten {@link unwatchModelDocument} would otherwise leak dispatch;
    * the implicit unwatch is idempotent). `watchModelDocument` is NOT
    * coupled the other way: opening does not force a watch, so a snapshot
    * reader can open without streaming.
    */
   closeModelDocument(args: CloseModelArgs): Promise<void>;

   /**
    * Get the current state of a document. The server-side build is brought
    * up to date before the response returns — callers don't need to await
    * a separate "ready" gate per request, only the global
    * {@link waitForReady} gate at startup.
    */
   getModelDocument(args: GetModelDocumentArgs): Promise<TransferDocument<TTransfer, TDiagnostic>>;

   /**
    * Update a document's content. The response carries the latest built
    * state including diagnostics; callers observe convergence via that
    * response.
    */
   updateModelDocument(args: TransferUpdateDocumentArgs<TTransfer>): Promise<TransferDocument<TTransfer, TDiagnostic>>;

   /**
    * Persist a document to disk. The response is the post-save document
    * state (matches the file on disk). Save semantics depend on the
    * filesystem-provider wiring; rejection paths surface as awaited
    * promise rejections.
    */
   saveModelDocument(args: TransferSaveDocumentArgs<TTransfer>): Promise<TransferDocument<TTransfer, TDiagnostic>>;

   /**
    * Start watching `(uri, clientId)`. The server starts dispatching
    * {@link DocumentClientProtocol.onDocumentUpdated} on the paired wire
    * for every build-phase event on `uri`.
    *
    * Returns `Promise<void>` — the bidirectional pattern means the event
    * channel is the client interface, not a returned handle. Callers fan
    * out a single inbound `onDocumentUpdated` to multiple local listeners
    * with their own `Emitter<T>` (matching Theia's pattern). Pair every
    * `watchModelDocument` with {@link unwatchModelDocument} when no longer
    * needed; the server holds the watch record until the matching unwatch
    * lands.
    */
   watchModelDocument(args: WatchModelDocumentArgs): Promise<void>;

   /**
    * Stop watching `(uri, clientId)` previously started by
    * {@link watchModelDocument}. Idempotent — unwatching twice is a no-op.
    */
   unwatchModelDocument(args: WatchModelDocumentArgs): Promise<void>;

   /**
    * Resolve once the data-server is ready to serve requests. The default
    * implementation in `DataServer` returns `Promise.resolve()`; adopters
    * that need to warm-load services (workspace indexing, custom service
    * initialisation) override this hook on their subclass.
    *
    * Callers SHOULD await `waitForReady` once at startup before the first
    * `getModelDocument` / subscription call — Langium's document builder
    * may otherwise miss documents added during the initial workspace
    * walk.
    */
   waitForReady(): Promise<void>;
}

/**
 * Project-scoped slice of the data-server wire contract: enumerate the
 * workspace's projects and resolve the project owning a URI.
 *
 * Generic over the project shape (`TProject`); most adopters use the
 * default {@link Project}. Composed into {@link DataServerProtocol}
 * alongside {@link DocumentServerProtocol}.
 */
export interface ProjectServerProtocol<TProject extends Project = Project> {
   /**
    * List projects exposed by the workspace. Returns an empty array when
    * no project tier is wired (e.g. `SingleProjectManager` default with no
    * descriptor discovery configured).
    */
   getProjects(): Promise<readonly TProject[]>;

   /**
    * Look up the project owning the given URI. Returns `undefined` when
    * the URI does not belong to any registered project, or when no
    * project tier is wired (the `SingleProjectManager` default returns
    * its synthetic workspace project for every URI, so that case never
    * resolves to `undefined`).
    *
    * Membership semantics are decided by the server's `ProjectManager`
    * implementation — the default in `AbstractProjectManager` is closest-
    * ancestor descriptor folder; adopters override for explicit URI
    * listings, glob patterns, manifest-declared file lists, etc.
    */
   getProjectForUri(args: GetProjectForUriArgs): Promise<TProject | undefined>;
}

/**
 * Typed RPC contract for the data-server protocol head — the server-exposed
 * surface clients call. Composed from the role-explicit fragments
 * {@link DocumentServerProtocol} (per-document lifecycle + subscriptions +
 * the readiness gate) and {@link ProjectServerProtocol} (project tier).
 * Implementations live in `@hydranium/data-server`; typed client proxies are
 * produced by `createRpcProxy` (in this package's `./rpc` subpath). The
 * wire-level method names are `DATA_SERVER_WIRE_PREFIX + methodName` for
 * every method in `DATA_SERVER_PROTOCOL_METHODS` (request methods)
 * and `DATA_CLIENT_PROTOCOL_METHODS` (notification methods).
 *
 * Most adopters parameterise only `TTransfer`; `TDiagnostic` defaults to
 * {@link TransferDiagnostic} and `TProject` to {@link Project}.
 *
 * **Bidirectional pattern.** `DataServerProtocol` is the SERVER-EXPOSED
 * surface — methods the client calls. The dual surface
 * {@link DataClientProtocol} contains methods the server calls (delivered
 * as JSON-RPC notifications). The pair composes via `createRpcProxy`
 * (`localTarget`/`localMethods`) so server and client are typed end-to-end
 * with no method-list drift.
 *
 * **Architectural placement.** The SOLE typed surface for the data-server
 * peer. `lsp-server` and `glsp-server` define their own peer-equivalent
 * surfaces and DO NOT extend this one; all three heads sit at the same tier,
 * coordinating through shared services in `@hydranium/core`.
 */
export interface DataServerProtocol<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project
>
   extends DocumentServerProtocol<TTransfer, TDiagnostic>, ProjectServerProtocol<TProject> {}

/**
 * Cross-reference / naming slice of the server surface — scope-aware
 * queries that resolve against the language's reference services. NOT part
 * of the {@link DataServerProtocol} composition: a pure data consumer
 * doesn't need it, so adopters compose it onto their connection explicitly.
 * The default `DataServer` impls delegate to
 * the per-language `references` services, resolved from each request's
 * source/URI (an `ElementSource` with no URI resolves to the sole
 * registered language; a multi-language workspace overrides).
 *
 * Generic over the transfer root type only — the resolution result
 * ({@link ReferenceTarget}) carries the resolved node's encoded subtree;
 * candidates and names are diagnostic-free.
 */
export interface ReferenceServerProtocol<TTransfer extends TransferElement> {
   /**
    * List the reference candidates reachable for the property named in `ctx`
    * from its (possibly synthetic) source. Backed by the language's
    * `ReferenceCandidateProvider`.
    */
   findReferenceCandidates(ctx: ReferenceContext): Promise<ReferenceCandidate[]>;

   /**
    * Resolve a concrete reference request to its target, returning the
    * target's document URI, display fields, and the resolved node's encoded
    * transfer subtree. Resolves via the language's reference services;
    * `undefined` when the reference does not resolve.
    */
   resolveReference(ref: ReferenceRequest): Promise<ReferenceTarget<TTransfer> | undefined>;

   /**
    * Compute the next free name for a new element of `args.type` based on
    * `args.proposal`, unique within the `args.tier` scope (default
    * `'project'`). Backed by the language's `NameProvider`.
    */
   findNextName(args: FindNextNameArgs): Promise<string>;
}

/**
 * Document-scoped slice of the client surface — notifications the server
 * delivers about subscribed documents. The dual of
 * {@link DocumentServerProtocol}.
 *
 * Notification methods are conventionally `on*`-prefixed so the generic
 * `createRpcProxy` helper routes them as `sendNotification` calls.
 * Multi-listener fan-out is the consumer's responsibility — wrap a local
 * implementation with an `Emitter<T>` to fan a single inbound
 * `onDocumentUpdated` call out to multiple local subscribers.
 */
export interface DocumentClientProtocol<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic> {
   /**
    * Delivered when a subscribed document reached one of the data-server's
    * configured build phases. Subscribers filter incoming events by URI
    * if they hold multiple subscriptions on the same wire.
    */
   onDocumentUpdated(event: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>): void;

   /**
    * Delivered when a subscribed document was persisted to disk via
    * {@link DocumentServerProtocol.saveModelDocument}. The persistence event
    * is delivered on a separate channel from the build-phase update
    * stream — subscribers tracking "saved" status (editor dirty-flag
    * indicators, external sync drivers) listen here instead of filtering
    * `onDocumentUpdated` for `reason: 'saved'` (the build-phase path
    * never emits `'saved'` because saves take a synchronous RPC-response
    * codepath, not a subscription codepath).
    */
   onDocumentSaved(event: TransferDocumentSavedEvent<TTransfer, TDiagnostic>): void;
}

/**
 * Project-scoped slice of the client surface — the project-registry change
 * notification. The dual of {@link ProjectServerProtocol}.
 */
export interface ProjectClientProtocol<TProject extends Project = Project> {
   /**
    * Delivered when a project was added, updated, or removed from the
    * registry. The data-server subscribes to its `ProjectManager`'s
    * change channel and fans the internal `ProjectChangeEvent` (which
    * carries arrays of added/updated/removed ids per registry diff) out
    * to one wire notification per affected project — `'removed'` events
    * carry the pre-removal snapshot so clients with no local cache can
    * still read the project's metadata.
    */
   onProjectsChanged(event: ProjectsChangedEvent<TProject>): void;
}

/**
 * Client-side surface — methods the data-server invokes on the client as
 * JSON-RPC notifications. The bidirectional dual of {@link DataServerProtocol},
 * composed from {@link DocumentClientProtocol} and {@link ProjectClientProtocol}.
 * A `createRpcProxy` over the connection exposes the server surface outbound and
 * binds an implementation of this interface inbound (`localTarget`).
 */
export interface DataClientProtocol<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project
>
   extends DocumentClientProtocol<TTransfer, TDiagnostic>, ProjectClientProtocol<TProject> {}
