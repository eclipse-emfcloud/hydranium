/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   createRpcProxy,
   defineMessage,
   DisposableCollection,
   isDocumentSource,
   isElementSource,
   isSyntheticSource,
   messageError,
   ReferenceSource,
   type CloseModelArgs,
   type HydraniumResponseError,
   type Disposable,
   type ElementSource,
   type FindNextNameArgs,
   type LatencyCollector,
   type LatencyReport,
   type OpenModelArgs,
   type Project,
   type ReferenceCandidate,
   type ReferenceContext,
   type ReferenceRequest,
   type ReferenceTarget,
   type Tracer,
   type TransferDiagnostic,
   type TransferDocument,
   type TransferElement
} from '@hydranium/protocol';
import {
   DATA_SERVER_DIAGNOSTICS_METHODS,
   DATA_SERVER_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerDiagnosticsProtocol,
   type DataServerProtocol,
   type DumpServerStateArgs,
   type StartProfilingArgs,
   type StopProfilingArgs,
   type WriteServerHeapSnapshotArgs,
   type GetModelDocumentArgs,
   type GetProjectForUriArgs,
   type TransferSaveDocumentArgs,
   type WatchModelDocumentArgs,
   type TransferDocumentSavedEvent,
   type TransferDocumentUpdatedEvent,
   type TransferUpdateDocumentArgs
} from '@hydranium/protocol/data';
import { REVERT_ON_CLOSE_CLIENT_ID, UNKNOWN_CLIENT_ID } from '@hydranium/core';
import { defaultDataServerDiagnostics } from './default-diagnostics.js';

/**
 * Raised when a profiling command arrives with no capture running.
 *
 * A `ResponseError` rather than a plain `Error` so the identity survives to the
 * response boundary, which is where the message is rendered. An unwrapped throw
 * reaches the client as a generic internal error instead: no code for a caller
 * to switch on, and nothing for the boundary to render from.
 */
export const NO_ACTIVE_PROFILE = defineMessage(
   'hydranium/data-server/no-active-profile',
   'No profiling capture is active; call startProfiling first.'
);

/**
 * The JSON-RPC code, unrelated to the catalogue code above: this one is numeric,
 * survives reconstruction and is what a caller switches on.
 */
export const NO_ACTIVE_PROFILE_CODE = 1002;

export const noActiveProfileError = (): HydraniumResponseError => messageError(NO_ACTIVE_PROFILE_CODE, NO_ACTIVE_PROFILE);

import type { DataServerDiagnosticsProvider, DataServerProfileCapture } from './diagnostics-provider.js';
import type {
   ClientTextDocumentChangeEvent,
   HydraniumLanguageServices,
   LogNameOptions,
   ModelService,
   ProjectChangeEvent,
   ServerSharedServices,
   TransferEncoder
} from '@hydranium/core';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { type AstNode, DocumentState, type LangiumDocument, UriUtils, type URI } from '@hydranium/langium';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';

/**
 * Domain separator between text and diagnostics inputs of
 * {@link DataServer.computeDocumentFingerprint}'s hash. A single NUL byte is
 * sufficient: the JSON-stringified diagnostics never contain a NUL byte, so
 * the boundary is unambiguous.
 */
const FINGERPRINT_SEPARATOR = '\0';

/**
 * Portable, non-cryptographic 64-bit fingerprint hash (cyrb53), returning a
 * 16-char hex digest.
 *
 * **A cryptographic hash via `node:crypto` is the wrong trade**: the
 * fingerprint only needs a stable signal that `(text, diagnostics)` changed
 * between emissions, and a `node:*` import would cost
 * `@hydranium/data-server` its browser-portability. Parts are fed
 * incrementally, char by char, so multi-MB document text is never
 * concatenated into one string.
 */
function fingerprintHash(parts: readonly string[]): string {
   let h1 = 0xdeadbeef;
   let h2 = 0x41c6ce57;
   for (const part of parts) {
      for (let i = 0; i < part.length; i++) {
         const ch = part.charCodeAt(i);
         h1 = Math.imul(h1 ^ ch, 2654435761);
         h2 = Math.imul(h2 ^ ch, 1597334677);
      }
   }
   h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
   h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
   h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
   h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
   const high = (h2 >>> 0).toString(16).padStart(8, '0');
   const low = (h1 >>> 0).toString(16).padStart(8, '0');
   return high + low;
}

/**
 * Which observable state {@link DataServer.computeDocumentFingerprint} hashes to
 * de-dup `onDocumentUpdated` emissions.
 *
 * - `'transfer-document'` (default) — the client-visible transfer root
 *   (`TransferEncoder.toTransferDocument`) plus diagnostics. This is exactly the
 *   payload `envelope` sends, so it changes whenever — and only when — the
 *   client-visible model changes, INCLUDING cross-document derived state
 *   folded in on a cascade rebuild that leaves the document's own text
 *   untouched. Safe for any adopter whose AST extensions fold derived state
 *   into the transfer projection (the framework norm).
 * - `'text-diagnostics'` — the cheaper `getText()` + diagnostics hash. An
 *   opt-DOWN for adopters that fold no derived state and want to avoid the
 *   transfer-encode per phase event.
 */
export type FingerprintStrategy = 'transfer-document' | 'text-diagnostics';

/** Hash a document's raw text + diagnostics — the `'text-diagnostics'` strategy. */
function textDiagnosticsFingerprint(document: LangiumDocument): string {
   return fingerprintHash([document.textDocument.getText(), FINGERPRINT_SEPARATOR, JSON.stringify(document.diagnostics ?? [])]);
}

/** Hash an encoded transfer document's root + diagnostics — the `'transfer-document'` strategy. */
function transferDocumentFingerprint(transferDocument: Pick<TransferDocument<TransferElement, unknown>, 'root' | 'diagnostics'>): string {
   // null, not undefined: `JSON.stringify(undefined)` yields undefined rather
   // than a string, putting a non-string into the hash inputs.
   return fingerprintHash([
      JSON.stringify(transferDocument.root ?? null),
      FINGERPRINT_SEPARATOR,
      JSON.stringify(transferDocument.diagnostics)
   ]);
}
/**
 * `logAfterMs` threshold passed to {@link Tracer.time} around
 * {@link DataServer.computeDocumentFingerprint}. Below this the timing
 * pair is suppressed so steady-state edits don't flood the log; above it
 * the pathological cases (multi-MB files, massive diagnostic batches)
 * surface naturally via the framework's standard timing pattern.
 */
const FINGERPRINT_LOG_AFTER_MS = 5;

/**
 * Construction-time options for {@link DataServer}. Every field is
 * optional; values not supplied fall back to {@link DataServer.DEFAULT_OPTIONS}.
 */
export interface DataServerOptions extends LogNameOptions {
   /**
    * Document phase at which the data-server fires subscription events
    * (`DataClientProtocol.onDocumentUpdated`).
    *
    * **Subscription dispatch only** — distinct from the synchronous RPC
    * response phase. The lifecycle reads/writes (`getModelDocument` /
    * `updateModelDocument` / `saveModelDocument`) settle at the
    * integrity-settled landmark (`IntegrityService.SettledState`); a
    * read additionally upgrades to `Validated` per call when
    * {@link GetModelDocumentArgs.includeDiagnostics} is set. This option
    * controls only the async notification phase.
    *
    * Default: `DocumentState.Validated` — validation is the last builder
    * phase and produces the full diagnostic set, so subscription events fired
    * at validation surface the complete diagnostic picture.
    *
    * **Trade-off.** Validation can take seconds on a real workspace. Adopters
    * that publish validation diagnostics through a separate channel —
    * typically LSP `publishDiagnostics` — can fire subscription events earlier
    * (e.g. `IndexedReferences`) since clients observe validation diagnostics
    * asynchronously via that channel regardless of when the subscription
    * event lands.
    */
   readonly subscriptionPhase?: DocumentState;

   /**
    * Runtime-specific implementation of the four diagnostics methods that need
    * a process to inspect — heap snapshot, profile capture, pod memory, server
    * state.
    *
    * **Defaulted per platform, so most hosts pass nothing.** On Node the default
    * is the real implementation; in a browser bundle `package.json`'s `browser`
    * field selects a twin whose methods reject, because there is no process to
    * inspect. Supply this only to override — a custom implementation, or to say
    * explicitly at the call site which one you mean.
    *
    * It is injected rather than reached for because a static
    * `@hydranium/core/node` import on this package's portable entry pulls
    * `node:fs`, `node:v8` and `node:perf_hooks` into any browser build, over
    * methods a browser cannot call anyway — which is what previously made the
    * head unbundleable.
    */
   readonly diagnostics?: DataServerDiagnosticsProvider;

   /**
    * Which observable state the `onDocumentUpdated` de-dup fingerprint hashes.
    * Defaults to `'transfer-document'` (the client-visible payload, derived
    * state included). See {@link FingerprintStrategy}.
    */
   readonly fingerprintStrategy?: FingerprintStrategy;

   /**
    * Wire-method namespace for both inbound request handlers and the
    * outbound notification client proxy. Defaults to
    * {@link DATA_SERVER_WIRE_PREFIX} (`'data-server/'`).
    *
    * Adopters that combine the data-server head with their own protocol
    * head on one connection pass their own namespace, so the full wire
    * surface is partitioned under one prefix instead of two, the way LSP
    * itself partitions `textDocument/*` and `workspace/*`. The client side
    * (the `methodNamespace` option of its client `createRpcProxy`) MUST
    * agree.
    */
   readonly methodNamespace?: string;

   /**
    * Additional protocol-method names to register as request handlers on
    * the same connection alongside the framework's
    * {@link DATA_SERVER_PROTOCOL_METHODS}. Used by `DataServer` subclasses
    * that implement an adopter-specific protocol — the subclass implements
    * the adopter methods on `this`, the names go here, and the
    * constructor's single `createRpcProxy` call (binding `this` as its
    * `localTarget`) registers framework + adopter handlers under one
    * namespace.
    *
    * Throws at construction time if any name overlaps with a built-in
    * framework method (would cause vscode-jsonrpc duplicate-handler
    * errors at registration). Notification-shaped (`on*`-prefixed) names
    * register as notification handlers; everything else as request
    * handlers — same `on*`-prefix heuristic the framework's
    * `bindRpcMethods` uses for `DataClientProtocol`.
    */
   readonly additionalMethods?: readonly string[];

   /**
    * Framework method names to NOT register on the wire. Used by adopters
    * that expose renamed domain-vocabulary equivalents of framework
    * methods and want to keep the wire surface free of the unused
    * framework names.
    *
    * Each name is filtered out of the combined `[framework + additional]`
    * set before the handlers are bound. The adopter typically pairs an
    * `excludedMethods` entry with an `additionalMethods` entry naming the
    * renamed equivalent on the same class — the subclass's renamed method
    * usually delegates to the inherited framework implementation via
    * `super.X()` so the behaviour stays identical.
    *
    * Names that are neither in `DATA_SERVER_PROTOCOL_METHODS` nor in
    * `additionalMethods` are simply no-ops — listing an unknown name does
    * not throw. The overlap-detection between `additionalMethods` and
    * built-in framework methods still fires for non-excluded names.
    */
   readonly excludedMethods?: readonly string[];

   /**
    * When supplied, every inbound data-server RPC is timed into this collector
    * (via the `createRpcProxy` binding) and exposed through
    * {@link DataServerDiagnosticsProtocol.getLatency}. A head that also runs an
    * LSP connection can pass the SAME collector to
    * `instrumentLspConnection(connection, latency)` so one report covers both
    * heads. Absent by default (no timing overhead).
    */
   readonly latency?: LatencyCollector;
}

/** Fully-resolved variant — every field set, used internally after merging defaults. */
interface ResolvedDataServerOptions {
   readonly subscriptionPhase: DocumentState;
   readonly fingerprintStrategy: FingerprintStrategy;
   readonly methodNamespace: string;
   readonly additionalMethods: readonly string[];
   readonly excludedMethods: readonly string[];
   /** Always resolved — to the caller's, or to the platform default. */
   readonly diagnostics: DataServerDiagnosticsProvider;
}

/**
 * Typed-RPC protocol head for the hydranium framework. The data-server
 * is a PEER of `@hydranium/core/lsp` and `@hydranium/glsp-server` —
 * all three heads coordinate through shared services in
 * `@hydranium/core` (multi-client text documents, self-save
 * registry, document-builder phases, project manager, ModelService
 * facade) and never depend on each other at the package level.
 *
 * **No abstract grammar hooks**. The data-server has no grammar-specific
 * abstract methods: `serialize` / `parseModel` live on
 * {@link ModelService} (the in-process facade), where the `update` /
 * `save` lifecycle owns the transfer-model round-trip. Adopters that want
 * to customise serialisation rebind `services.model.ModelService` with a
 * subclass; adopters that need a typed-overlay encoder rebind
 * `services.model.TransferEncoder` with a subclass exposing the typed
 * `TTransferMap`.
 *
 * **What still subclasses**. The data-server is concrete by default;
 * adopters subclass ONLY when they need to decorate wire returns or
 * notifications. The usual adoption path is DI rebinds alone.
 *
 * Lifecycle: the constructor registers framework request handlers (plus
 * any names supplied via {@link DataServerOptions.additionalMethods}) and
 * builds the {@link DataClientProtocol} notification proxy on the same
 * connection in one {@link createRpcProxy} call (binding `this` as its
 * `localTarget`) under the configured namespace, and subscribes one
 * `DocumentBuilder.onDocumentPhase` listener per configured phase that
 * dispatches subscription events via `clientProxy.onDocumentUpdated`.
 *
 * The data-server requires the full {@link ServerSharedServices}
 * shape — `HydraniumTextDocuments` for client-attributed updates,
 * `WritableFileSystemProvider` for save, `SelfSaveRegistry` for
 * save-echo suppression, `ProjectManager` for project listing,
 * `ModelService` for the lifecycle delegate, `TransferEncoder` for
 * wire envelope construction — all of which the framework's
 * `createServerSharedModule` binds by default.
 *
 * **No per-head shared module.** The data-server head does not surface a
 * `createDataServerSharedModule` factory because it contributes no
 * shared-tier bindings: it reads exclusively from
 * {@link ServerSharedServices}. An empty factory would only mislead
 * adopters into composing it as though it were the canonical adoption
 * path.
 */
export class DataServer<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project
>
   implements DataServerProtocol<TTransfer, TDiagnostic, TProject>, DataServerDiagnosticsProtocol, Disposable
{
   /**
    * Framework defaults, exposed so an adopter can spread them when
    * extending rather than restate a value the framework may change.
    */
   static readonly DEFAULT_OPTIONS: Required<Pick<DataServerOptions, 'subscriptionPhase'>> = {
      subscriptionPhase: DocumentState.Validated
   };

   protected readonly options: ResolvedDataServerOptions;
   /** Subscription bookkeeping: URI → set of clientIds that subscribed for that URI. */
   protected readonly subscriptions = new Map<string, Set<string>>();
   /**
    * Open-document bookkeeping: URI → set of clientIds that opened it over THIS
    * connection.
    *
    * Kept because the document store releases a client's hold only from an
    * explicit close, and a client that dies without closing would otherwise keep
    * the document open forever — resident, and with its last-close revert
    * suppressed. The store has no notion of which connection a clientId reached
    * it over, so the connection-scoped set has to live here; teaching it a client
    * identity is the more robust and much larger alternative.
    */
   protected readonly openedDocuments = new Map<string, Set<string>>();
   /** Typed client proxy — sends `data-server/on*` notifications back over the same wire. */
   protected readonly clientProxy: DataClientProtocol<TTransfer, TDiagnostic, TProject>;
   protected readonly disposables = new DisposableCollection();
   /**
    * Snapshot of the most recent `DocumentBuilder.onUpdate` event. Drives
    * `reason` discrimination on outbound `onDocumentUpdated` notifications:
    * a URI in the `changed` list emits `'changed'`, in `deleted` emits
    * `'deleted'`, otherwise `'rebuilt'` (cascade rebuild from a dependent
    * URI's change). The same mechanism `AstDocumentManager.onUpdate` uses on
    * the LSP side, so reason fidelity stays consistent between heads.
    */
   protected lastBuildUpdate?: { changed: readonly URI[]; deleted: readonly URI[] };
   /**
    * Per-URI hash of the last emitted (text + diagnostics) state,
    * used by {@link dispatchPhaseEvent} to suppress duplicate
    * `onDocumentUpdated` notifications for rebuilds that produce no
    * observable change since the last emit.
    *
    * Two scenarios routinely produce such rebuilds:
    * 1. **Refresh-triggered rebuilds.** When a second client attaches to a
    *    document already open in another client,
    *    `HydraniumTextDocuments.refreshContent` fires `onDidChangeContent`
    *    purely to re-trigger the build pipeline — the text and diagnostics
    *    are identical to the prior emit.
    * 2. **Cascade rebuilds with no diagnostic delta.** Langium rebuilds a
    *    document when a dependency changes; if the rebuild produces the
    *    same diagnostics, there is nothing new to communicate to subscribers.
    *
    * Without this filter, both scenarios reach subscribers as wire-side
    * `'changed'` events. A subscriber that interprets `'changed'` as
    * "another client wrote new content" and resets its in-memory root to
    * the server view then misreads the spurious event as a concurrent
    * third-party write and loses the user's edits.
    *
    * Initialised on {@link watchModelDocument} to the current
    * document fingerprint so the FIRST phase event after a fresh
    * subscription is also de-duplicated against the state subscribers
    * obtained via `getModelDocument` — they do not need a redundant phase
    * notification for the state they just fetched.
    *
    * Cleared in {@link unwatchModelDocument} when the last
    * subscriber for a URI leaves so memory does not accumulate.
    *
    * Stored as a cyrb53 hex digest (16 chars per URI) rather than the raw
    * text + diagnostics serialisation so the memory cost is constant in
    * document size. See {@link computeDocumentFingerprint} for the inputs.
    */
   protected readonly lastEmittedFingerprint = new Map<string, string>();
   /**
    * URIs whose LAST client just closed. The update handler rebuilds such a
    * document from its disk content (discarding unsaved in-session edits),
    * but {@link dispatchPhaseEvent} gates on the subscription map — and the
    * last close typically also removed the last watcher, so consumers that
    * only ever fetch via `getModelDocument` would keep showing the
    * discarded state forever. Marked on the last-close transition (see
    * {@link subscribeToTextDocumentCloses}) and consumed by
    * {@link dispatchPhaseEvent}, which broadcasts the following rebuild's
    * phase event even without a subscription — de-duplicated against
    * {@link lastEmittedFingerprint} where an entry survives, so a close
    * whose disk state equals the last emitted state stays silent.
    */
   protected readonly pendingRevertBroadcasts = new Set<string>();
   protected readonly tracer: Tracer;
   /** The in-flight interactive profile capture, held between {@link startProfiling} and {@link stopProfiling}. */
   protected activeProfile?: DataServerProfileCapture;
   /** Set once {@link dispose} has run, so a capture that starts after teardown is stopped instead of leaked. */
   protected disposed = false;
   /** Per-method RPC latency collector, when the head opted in via {@link DataServerOptions.latency}. */
   protected readonly latency?: LatencyCollector;
   /** Encoder pulled from DI. Adopters rebind `services.model.TransferEncoder` to a typed-overlay subclass. */
   protected readonly encoder: TransferEncoder<unknown, TDiagnostic>;
   /**
    * In-process workspace facade — the lifecycle delegate `get` / `update` / `save` go through.
    * The facade's AstDocument diagnostic shape is intentionally typed `unknown` here: adopters
    * carry LSP-shape diagnostics in their AstDocument (e.g. an adopter's LSP-shape diagnostic type)
    * while the wire shape stays `TDiagnostic extends TransferDiagnostic`. The encoder's
    * `astDocumentToTransferDocument` accepts both shapes (wire-shape or LSP-shape) and projects
    * to wire shape on the return — see `TransferEncoder.astDocumentToTransferDocument`.
    */
   protected readonly modelService: ModelService<AstNode, unknown, TTransfer>;

   constructor(
      protected readonly connection: MessageConnection,
      protected readonly services: ServerSharedServices<TProject>,
      options: DataServerOptions = {}
   ) {
      this.options = this.resolveOptions(options);
      this.tracer = this.services.Tracer.for(options.logName ?? 'DataServer').trace('instantiated');
      // DI-bound: adopters rebind `services.model.TransferEncoder` /
      // `services.model.ModelService` with their own subclasses. Slot types use the
      // framework upper bounds; the casts below narrow to this instance's generics.
      const { TransferEncoder: encoder, ModelService: modelService } = this.services.model;
      if (!encoder || !modelService) {
         throw new Error(
            'DataServer requires `services.model.TransferEncoder` and `services.model.ModelService` to be bound. ' +
               'Did you compose `createServerSharedModule(ctx)` into your shared module?'
         );
      }
      this.encoder = encoder as TransferEncoder<unknown, TDiagnostic>;
      this.modelService = modelService as ModelService<AstNode, unknown, TTransfer>;
      const excluded = new Set<string>(this.options.excludedMethods);
      const registeredMethods = [
         ...DATA_SERVER_PROTOCOL_METHODS,
         ...DATA_SERVER_DIAGNOSTICS_METHODS,
         ...this.options.additionalMethods
      ].filter(name => !excluded.has(name));
      // One call builds the outbound notification proxy AND registers the
      // inbound handlers. A separate `bindRpcMethods` call per slice would
      // force a subclass to re-bind in its own constructor to contribute
      // methods alongside the framework's.
      this.latency = options.latency;
      this.clientProxy = createRpcProxy<DataClientProtocol<TTransfer, TDiagnostic, TProject>, this>(connection, {
         methodNamespace: this.options.methodNamespace,
         localTarget: this,
         localMethods: registeredMethods as readonly (keyof this & string)[],
         latency: this.latency,
         // Bound at the chokepoint rather than per handler, so an adopter's
         // `additionalMethods` are rendered on the same terms as the
         // framework's own rejections.
         renderErrorMessage: error => this.services.MessageRenderer.renderError(error)
      });
      this.disposables.push(
         this.services.workspace.DocumentBuilder.onUpdate((changed, deleted) => {
            this.lastBuildUpdate = { changed, deleted };
         })
      );
      this.subscribeToDocumentBuilder();
      this.subscribeToTextDocumentSaves();
      this.subscribeToTextDocumentCloses();
      this.subscribeToProjectManager();
      // Self-register teardown so an adopter that keeps no reference to the
      // server still releases per-connection state, with no lifecycle hook of
      // its own. See `dispose`.
      this.disposables.push(connection.onClose(() => this.dispose()));
   }

   /**
    * Release everything the constructor wired up — the bound protocol
    * handlers and every listener — and clear the subscription map and the
    * per-URI emission-fingerprint cache, so a long-lived shared services
    * bundle does not retain per-connection memory after the connection
    * closes. Also closes every document still open over this connection (see
    * {@link closeOpenDocuments}), which is the SHARED store's state rather than
    * this server's and so outlives the connection unless released here.
    *
    * Idempotent: subsequent calls are no-ops. Self-fires on
    * `connection.onClose` so adopters who don't hold a reference still
    * get per-connection cleanup; adopters that DO hold a reference may
    * call `dispose()` directly for early teardown.
    */
   dispose(): void {
      this.disposed = true;
      // Release an in-flight interactive capture so the process-wide inspector
      // singleton is not left active after the connection closes.
      if (this.activeProfile) {
         const capture = this.activeProfile;
         this.activeProfile = undefined;
         void capture.stop({}).catch(() => undefined);
      }
      // AFTER `disposables.dispose()`, deliberately: closing a document fires
      // `onDidClose`, and this server's own close listener would otherwise mark a
      // revert broadcast for a connection that is already gone.
      this.disposables.dispose();
      this.closeOpenDocuments();
      this.subscriptions.clear();
      this.lastEmittedFingerprint.clear();
      this.pendingRevertBroadcasts.clear();
   }

   // ============================================================
   // DataServerProtocol implementation — delegates to ModelService.
   // ============================================================
   //
   // The lifecycle methods (`get` / `update` / `save` / `ready`) forward
   // straight to `ModelService` and encode the returned `AstDocument` on
   // the wire boundary via `encoder.astDocumentToTransferDocument`.
   // Adopters customising lifecycle behaviour (normalisation, supersession,
   // settled-phase choice, etc.) override on the ModelService subclass —
   // no override on DataServer is needed.

   async openModelDocument(args: OpenModelArgs): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      // Register the editor session (idempotent — `ModelService.open` refreshes
      // an already-open document rather than re-opening), then return the built
      // state at the configured target phase. The one-shot snapshot; subsequent
      // build-phase events arrive via `watchModelDocument`.
      await this.modelService.open(args);
      // Record the hold so `dispose` can release it for a client that never
      // closes. Keyed by the URI as given, because that is what `close` takes.
      let holders = this.openedDocuments.get(args.uri);
      if (!holders) {
         holders = new Set<string>();
         this.openedDocuments.set(args.uri, holders);
      }
      holders.add(args.clientId);
      const document = await this.getModelDocument({ uri: args.uri });
      // Project the authoritative client-facing version onto the open snapshot.
      // `getModelDocument` encodes the freshly-built AST snapshot, whose version
      // is the `LangiumDocument`'s own `textDocument.version`. That lags the
      // multi-client synced version whenever the open seeded the synced document
      // with a caller-supplied version id — and the synced version is what
      // `ModelService.update`'s optimistic-concurrency gate compares
      // `baseVersion` against, so reporting the snapshot's would make the
      // caller's first tagged write self-conflict. A genuine concurrent edit
      // still trips the gate and is reconciled by the caller's replay rather
      // than predicted here.
      return { ...document, version: this.services.workspace.TextDocuments.version(args.uri) };
   }

   async closeModelDocument(args: CloseModelArgs): Promise<void> {
      // Closing a session also releases its watch for (uri, clientId) — a
      // forgotten unwatch would otherwise leak phase-event dispatch until the
      // connection closes. Idempotent: a close without a prior watch is a no-op.
      await this.unwatchModelDocument({ uri: args.uri, clientId: args.clientId });
      this.forgetOpenDocument(args.uri, args.clientId);
      await this.modelService.close(args);
   }

   /**
    * Drop the recorded hold for `(uri, clientId)` so {@link dispose} does not
    * close it a second time. Idempotent.
    */
   protected forgetOpenDocument(uri: string, clientId: string): void {
      const holders = this.openedDocuments.get(uri);
      if (!holders) {
         return;
      }
      holders.delete(clientId);
      if (holders.size === 0) {
         this.openedDocuments.delete(uri);
      }
   }

   /**
    * Close every document still open over this connection, for the clients that
    * opened it here.
    *
    * The document store releases a per-URI hold only from an explicit close, so
    * without this a client that dies mid-session keeps its documents open for the
    * lifetime of the process: `isOpenInAnyClient` stays true, the document stays
    * resident, and the last-close revert never runs. A long-lived multi-client
    * head is the configuration where a dead client is normal rather than
    * exceptional, so the leak accumulates there.
    *
    * Runs from {@link dispose}, which is synchronous, so each close is fired and
    * its failure swallowed — a teardown must not reject, and a URI whose close
    * fails is no worse off than it was before this drain existed.
    */
   protected closeOpenDocuments(): void {
      const held = [...this.openedDocuments];
      this.openedDocuments.clear();
      for (const [uri, clientIds] of held) {
         for (const clientId of clientIds) {
            void Promise.resolve(this.modelService.close({ uri, clientId })).catch(() => undefined);
         }
      }
   }

   async getModelDocument(args: GetModelDocumentArgs): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      // Smart dispatch: a warm document (already in LangiumDocuments) is
      // returned at its settle phase without a redundant build; a cold URI
      // falls through to a fresh build. update/save already drive builds, so
      // this read path does not need to force one, which would make every
      // polling read pay for a rebuild.
      //
      // Defaults to the integrity-settled landmark (diagnostics may be absent,
      // delivered asynchronously via the subscription channel). A one-shot /
      // unsubscribed caller that needs diagnostics inline passes
      // `includeDiagnostics: true` to settle at `Validated` instead.
      const state = args.includeDiagnostics ? DocumentState.Validated : undefined;
      const astDocument = await this.modelService.ensureDocumentState(args.uri, state);
      return this.encoder.astDocumentToTransferDocument(astDocument as never) as unknown as TransferDocument<TTransfer, TDiagnostic>;
   }

   async updateModelDocument(args: TransferUpdateDocumentArgs<TTransfer>): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      const astDocument = await this.modelService.update(args);
      return this.encoder.astDocumentToTransferDocument(astDocument as never) as unknown as TransferDocument<TTransfer, TDiagnostic>;
   }

   async saveModelDocument(args: TransferSaveDocumentArgs<TTransfer>): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      const astDocument = await this.modelService.save(args);
      return this.encoder.astDocumentToTransferDocument(astDocument as never) as unknown as TransferDocument<TTransfer, TDiagnostic>;
   }

   /**
    * Record a watch for `(uri, clientId)`. Subsequent phase events on `uri`
    * fan out to the wired `clientProxy.onDocumentUpdated`. The
    * bidirectional pattern means the event channel is the client
    * notification surface, not a returned handle — this method only
    * registers the URI in the dispatch table.
    *
    * Also baselines the per-URI emission fingerprint (see
    * {@link lastEmittedFingerprint}) to the document's current state when
    * the first watcher for the URI registers. This guarantees that any
    * phase event firing immediately after the watch with no observable
    * change is suppressed — watchers obtain initial state via
    * `getModelDocument` (or {@link openModelDocument}) and do not need a
    * redundant phase notification for that same state.
    */
   async watchModelDocument(args: WatchModelDocumentArgs): Promise<void> {
      const uri = this.canonicalKey(args.uri);
      let subscribers = this.subscriptions.get(uri);
      if (!subscribers) {
         subscribers = new Set();
         this.subscriptions.set(uri, subscribers);
      }
      subscribers.add(args.clientId);
      if (!this.lastEmittedFingerprint.has(uri)) {
         const document = this.services.workspace.LangiumDocuments.getDocument(UriUtils.toUri(uri));
         if (document) {
            this.lastEmittedFingerprint.set(uri, this.computeDocumentFingerprint(document));
         }
      }
   }

   /**
    * Remove a watch for `(uri, clientId)` previously created by
    * {@link watchModelDocument}. Idempotent — unwatching twice is a no-op.
    * Dispatch for `uri` stops once no watchers remain, at which point the
    * per-URI emission fingerprint is also cleared so the next first-watch
    * re-baselines against the then-current document state rather than a
    * stale snapshot from the previous watch.
    */
   async unwatchModelDocument(args: WatchModelDocumentArgs): Promise<void> {
      const uri = this.canonicalKey(args.uri);
      const subscribers = this.subscriptions.get(uri);
      if (!subscribers) {
         return;
      }
      subscribers.delete(args.clientId);
      if (subscribers.size === 0) {
         this.subscriptions.delete(uri);
         this.lastEmittedFingerprint.delete(uri);
      }
   }

   /**
    * Canonicalise a URI string for use as a subscription / fingerprint
    * map key, via the shared `DocumentUriPolicy`. Callers may send
    * non-canonical URIs (drive-letter casing, percent-encoding differences,
    * or a symlink path) over the wire; the dispatch side keys by
    * `document.uri.toString()` from `LangiumDocuments`, so writer keys must
    * canonicalise to the same form or events silently fail to deliver.
    * Routing through the seam (rather than a bare `UriUtils.normalize`)
    * means that when an adopter strengthens document identity — e.g.
    * real-path (symlink) resolution — the data-server head's keys track
    * it too, instead of carrying the same path-identity divergence the
    * LSP head resolves.
    *
    * Adopters can still override for head-specific URI policy by subclassing.
    */
   protected canonicalKey(uri: string): string {
      return this.services.workspace.DocumentUriPolicy.canonicalUri(uri);
   }

   async getProjects(): Promise<readonly TProject[]> {
      // Pass-through: `ProjectManager<TProject>` already produces `TProject`
      // (the shared services are parameterised over the same generic).
      // The framework reads `id` for registry identity and `dependencies`
      // for the visibility closure; every other field rides on the
      // JSON-RPC envelope as adopter-defined wire metadata.
      return this.services.workspace.ProjectManager.getProjects();
   }

   async getProjectForUri(args: GetProjectForUriArgs): Promise<TProject | undefined> {
      // Pass-through: `ProjectManager.getProject(uri)` already returns the
      // adopter's `TProject` shape. Membership logic belongs to the adopter's
      // `ProjectManager`; the data-server forwards the URI without
      // interpretation.
      return this.services.workspace.ProjectManager.getProject(UriUtils.toUri(args.uri));
   }

   /**
    * Resolve once the data-server is ready to serve requests. Delegates
    * to {@link ModelService.ready} so adopters that warm-load services
    * (workspace indexing, etc.) override the `ModelService` slot in
    * their shared module rather than this method on a DataServer
    * subclass.
    */
   async waitForReady(): Promise<void> {
      await this.modelService.ready;
   }

   // ============================================================
   // ReferenceServerProtocol defaults — opt-in (not in DataServerProtocol).
   // Resolve the language's reference services from each request's source
   // (see resolveReferenceServices) and delegate.
   // ============================================================

   async findReferenceCandidates(ctx: ReferenceContext): Promise<ReferenceCandidate[]> {
      // Candidates are derived from resolved cross-references, so the relevant document(s) must
      // have finished the Linked phase — otherwise a query issued right after a model update races
      // the asynchronous rebuild and returns stale candidates. Wait the source document
      // specifically, but ONLY when a document is actually loaded at that URI: a synthetic source
      // can address a URI with no document (a directory URI, typically), and a per-URI `waitUntil`
      // there throws "No document found". Fall back to a global Linked settle, matching the
      // id-based ElementSource (no URI) path.
      const uri = isDocumentSource(ctx.source) || isSyntheticSource(ctx.source) ? UriUtils.toUri(ctx.source.uri) : undefined;
      const waitUri = uri && this.services.workspace.LangiumDocuments.hasDocument(uri) ? uri : undefined;
      await this.services.workspace.DocumentBuilder.waitUntil(DocumentState.Linked, waitUri);
      return this.resolveReferenceServices(ctx.source).CandidateProvider.find(ctx);
   }

   async resolveReference(ref: ReferenceRequest): Promise<ReferenceTarget<TTransfer> | undefined> {
      const resolved = this.resolveReferenceServices(ref.source).CandidateProvider.resolveCandidate(ref);
      if (!resolved) {
         return undefined;
      }
      const element = this.encoder.toTransfer(resolved.node) as unknown as TTransfer;
      return { ...resolved.candidate, element };
   }

   async findNextName(args: FindNextNameArgs): Promise<string> {
      const uri = UriUtils.toUri(args.uri);
      // Route through the same router as every other reference method.
      // `args` carries a URI and an AST type, which is precisely a
      // synthetic source — and the create-element flow driving this method is
      // the one that produces directory URIs, on which a bare
      // `getServices(uri)` throws while `findReferenceCandidates` succeeds.
      const nameProvider = this.resolveReferenceServices(ReferenceSource.synthetic(args.uri, args.type)).NameProvider;
      const tier = args.tier ?? 'project';
      if (tier === 'public') {
         return nameProvider.findNextProjectQualifiedName(args.type, args.proposal);
      }
      if (tier === 'local') {
         // Document-scoped uniqueness: the document root is the container.
         const document = await this.modelService.ensureDocumentState(args.uri);
         return document.root ? nameProvider.findNextName(args.type, args.proposal, document.root as AstNode) : args.proposal;
      }
      const project = this.services.workspace.ProjectManager.getProject(uri);
      if (!project) {
         // Project-tier uniqueness on a URI no project owns: the scope the
         // caller asked about does not exist. Widen to workspace-wide, which is
         // a strict superset — a name unique across every project is unique
         // within any one of them, so this can only add a suffix, never miss a
         // collision. Filtering on an empty project id instead would match no
         // element, and so always answer "no collisions" with the bare
         // proposal. Unreachable for adopters on the default
         // `SingleProjectManager`, which owns every URI.
         return nameProvider.findNextProjectQualifiedName(args.type, args.proposal);
      }
      return nameProvider.findNextDocumentQualifiedName(args.type, args.proposal, project.id);
   }

   /**
    * Resolve the per-language `references` services for a reference source.
    * Delegates the language choice to {@link resolveReferenceLanguage} and
    * throws when no language owns the source — the reference heads have no
    * meaningful empty answer (an empty candidate list reads to the client as
    * "nothing matches" and hides the misrouting).
    */
   protected resolveReferenceServices(source: ReferenceSource): HydraniumLanguageServices['references'] {
      const language = this.resolveReferenceLanguage(source);
      if (!language) {
         throw new Error(
            'DataServer cannot resolve the language for a reference source whose URI matches no registered ' +
               'language in a multi-language workspace. Override `fallbackReferenceLanguage` on your DataServer ' +
               'subclass to name the language such sources belong to.'
         );
      }
      return language.references;
   }

   /**
    * Pick the language that owns a reference source, in order:
    *
    * 1. A URI-bearing source ({@link isDocumentSource}/{@link isSyntheticSource})
    *    whose URI resolves to a registered language routes by URI.
    * 2. A single-language workspace always routes to that one language — so
    *    single-language adopters never reach the steps below, and never pay
    *    for them.
    * 3. An {@link isElementSource} source carries no URI, so in a
    *    multi-language workspace it is routed via the document that holds the
    *    element (see {@link findElementDocumentUri}).
    * 4. A source carrying an AST type is routed by that type when exactly one
    *    registered grammar can produce it (see
    *    {@link resolveReferenceLanguageByType}, over the registry's own type
    *    index). This is what resolves a create-element flow's synthetic source
    *    on a bare directory URI without asking the adopter.
    * 5. Anything still unresolved falls to {@link fallbackReferenceLanguage},
    *    which is adopter policy.
    */
   protected resolveReferenceLanguage(source: ReferenceSource): HydraniumLanguageServices | undefined {
      const registry = this.services.ServiceRegistry;
      // `getServicesFor` (non-throwing, one ladder walk) gates the URI lookup:
      // an extensionless / unregistered URI falls through to the steps below
      // rather than throwing "no services for the extension ''".
      const uri = isDocumentSource(source) || isSyntheticSource(source) ? UriUtils.toUri(source.uri) : undefined;
      const byUri = uri && registry.getServicesFor(uri);
      if (byUri) {
         return byUri;
      }
      const all = registry.all;
      if (all.length === 1) {
         return all[0] as HydraniumLanguageServices;
      }
      if (isElementSource(source)) {
         const documentUri = this.findElementDocumentUri(source);
         const byDocument = documentUri && registry.getServicesFor(documentUri);
         if (byDocument) {
            return byDocument;
         }
      }
      const byType = this.resolveReferenceLanguageByType(source);
      return byType ?? this.fallbackReferenceLanguage(source);
   }

   /**
    * Route a reference source by the AST type it carries — a
    * {@link isSyntheticSource}'s `type` (the transient node being created) or an
    * {@link isElementSource}'s optional narrowing `type`.
    *
    * Answers only when EXACTLY ONE registered grammar can produce the type.
    * Several can when the type comes from a grammar both import, and then the
    * type genuinely does not identify a language — that is a fall-through to
    * adopter policy, not a coin toss. Note this asks which grammar can *produce*
    * the type, not which mentions it: a grammar that merely cross-references a
    * type can never hold a node of it.
    */
   protected resolveReferenceLanguageByType(source: ReferenceSource): HydraniumLanguageServices | undefined {
      const type = isSyntheticSource(source) ? source.type : isElementSource(source) ? source.type : undefined;
      // The registry owns the type index — it is the one place that knows when
      // the registered set changed, so unlike a private memo here it cannot go
      // stale on a language registered after the first lookup.
      return type ? this.services.ServiceRegistry.soleServicesByType(type) : undefined;
   }

   /**
    * Locate the document that holds the element an {@link ElementSource}
    * addresses, via the index's O(1) name lookup — `name` is the qualified
    * name the `NameProvider` wrote into the index, and the optional `type`
    * disambiguates names that repeat across types (honouring grammar
    * subtyping through `AstReflection.isSubtype`).
    *
    * Only reached on the multi-language, name-based path (step 3 of
    * {@link resolveReferenceLanguage}); single-language adopters return at
    * step 2.
    *
    * Abstains when the name matches elements in more than one DOCUMENT — the
    * index spans every language and is filled in build order, so "the
    * first match" would be file-watch order rather than an answer. Step 3
    * then falls through to the type-based step 4, which abstains on ties
    * in the same way, and finally to adopter policy.
    */
   protected findElementDocumentUri(source: ElementSource): URI | undefined {
      const matches = this.services.workspace.IndexManager.getElementsByName(source.name, source.type);
      const [first] = matches;
      if (!first) {
         return undefined;
      }
      // Routing only asks WHICH DOCUMENT, so several descriptions of the same
      // document are not ambiguous — one element is routinely indexed several
      // times, once per visibility tier and once more for a wrapper root
      // beside its semantic root. Only matches that disagree on the document
      // are ambiguous.
      return matches.every(match => match.documentUri.toString() === first.documentUri.toString()) ? first.documentUri : undefined;
   }

   /**
    * Language to serve reference queries whose source names no language of
    * its own — a synthetic source addressing a URI with no (or an
    * unregistered) extension, or an element id absent from the index.
    *
    * Returns `undefined` by default, which makes
    * {@link resolveReferenceServices} throw. Only reachable in a
    * multi-language workspace, where choosing among the registered languages
    * is adopter policy: override and return the language such sources belong
    * to.
    */
   protected fallbackReferenceLanguage(_source: ReferenceSource): HydraniumLanguageServices | undefined {
      return undefined;
   }

   // ============================================================
   // Internal plumbing
   // ============================================================

   /**
    * Build a {@link TransferDocument} envelope from the current document state,
    * delegating root + diagnostic encoding to {@link encoder} (see
    * `TransferEncoder.toTransferDocument` for the walk).
    *
    * The encoder field's generic-map binding is widened to
    * `Record<string, TransferElement>` at the framework-default level, and an
    * adopter supplying a typed-overlay encoder narrows the runtime shape to
    * its wire types. The cast on the return is where that invariant — the
    * adopter's `TTransfer` matches its encoder's overlay — is asserted, at a
    * single boundary point rather than spread across the callers.
    */
   protected envelope(uri: URI): TransferDocument<TTransfer, TDiagnostic> {
      // Resolve through the model service's canonicalizing gateway rather than
      // reaching into `LangiumDocuments` directly, so a divergent (symlink) URI
      // still finds the document the build keys by its real path — and so the
      // data-server never has to remember to canonicalize this lookup itself.
      const document = this.modelService.getDocument(uri.toString());
      if (!document) {
         // No document — a shaped envelope rather than a throw, so the caller
         // decides policy at its own layer; `root` is optional on the envelope
         // so the compiler forces that decision. Adopters preferring to throw
         // override `envelope`.
         return {
            uri: uri.toString(),
            version: 0,
            root: undefined,
            diagnostics: [] as TDiagnostic[]
         };
      }
      return this.encoder.toTransferDocument<AstNode>(document) as unknown as TransferDocument<TTransfer, TDiagnostic>;
   }

   /**
    * Subscribe one listener at the configured {@link DataServerOptions.subscriptionPhase}.
    * The listener dispatches subscription events for every matching URI. A
    * single listener (rather than one per subscription) keeps the cost flat
    * regardless of subscriber count.
    */
   protected subscribeToDocumentBuilder(): void {
      this.disposables.push(
         this.services.workspace.DocumentBuilder.onDocumentPhase(this.options.subscriptionPhase, (document, cancelToken) =>
            this.dispatchPhaseEvent(document, cancelToken)
         )
      );
   }

   /**
    * Subscribe to the universal save event on `HydraniumTextDocuments` so a
    * single `onDocumentSaved` wire notification fires for ANY save of a
    * subscribed URI — regardless of whether the save originated from the
    * data-server's RPC `saveModelDocument`, the LSP head's text-editor save,
    * or any other client writing through `notifyDidSaveTextDocument`.
    *
    * Architectural symmetry with {@link subscribeToDocumentBuilder}: every
    * subscribed client sees every state change to documents they care about,
    * regardless of which client triggered it. Firing `onDocumentSaved` only
    * from the data-server's own RPC path is a bug, not an optimisation: an
    * LSP-driven save then lands on disk without notifying the subscribed
    * clients, which never clear their dirty state.
    */
   protected subscribeToTextDocumentSaves(): void {
      this.disposables.push(this.services.workspace.TextDocuments.onDidSave(event => this.dispatchSaveEvent(event)));
   }

   /**
    * Mark the last-close transition per URI (see
    * {@link pendingRevertBroadcasts}). The listener consults
    * `isOpenInAnyClient` AFTER the store decremented the closing client's
    * hold, so a `false` answer means this close was the last one.
    */
   protected subscribeToTextDocumentCloses(): void {
      const textDocuments = this.services.workspace.TextDocuments;
      this.disposables.push(
         textDocuments.onDidClose(event => {
            if (!textDocuments.isOpenInAnyClient(event.document.uri)) {
               this.pendingRevertBroadcasts.add(this.canonicalKey(event.document.uri));
            }
         })
      );
   }

   /** Fan out a save event for the document's URI, gated by the subscription map. */
   protected dispatchSaveEvent(event: ClientTextDocumentChangeEvent<TextDocument>): void {
      // The save event arrives under the CLIENT URI the text store keys by (e.g. a
      // symlink path S); the subscription map and `dispatchPhaseEvent` key by the
      // CANONICAL identity R. Canonicalize before both the gate and the envelope so
      // a save of a symlinked file isn't silently dropped (and the envelope resolves
      // the R-keyed document rather than missing into an empty one).
      const uri = this.canonicalKey(event.document.uri);
      if (!this.subscriptions.has(uri)) {
         return;
      }
      const response = this.envelope(UriUtils.toUri(uri));
      const wireEvent: TransferDocumentSavedEvent<TTransfer, TDiagnostic> = {
         document: response,
         sourceClientId: event.clientId
      };
      this.clientProxy.onDocumentSaved(wireEvent);
   }

   /**
    * Fan out a phase event for the document's URI by calling
    * `clientProxy.onDocumentUpdated`. The proxy lowers the call to a
    * `data-server/onDocumentUpdated` wire notification; the paired client
    * (bound via the client `createRpcProxy`'s `localTarget`/`localMethods`)
    * routes it to its handler. Adopters fan a single inbound onDocumentUpdated
    * out to multiple local subscribers with an `Emitter<T>` — the
    * framework deliberately does NOT promise multi-listener semantics.
    *
    * The dispatch is guarded by two filters:
    *   1. **Subscription map**: events for URIs no subscriber registered for
    *      are NOT sent over the wire (bandwidth scales with subscribed URIs,
    *      not phase events).
    *   2. **Emission fingerprint**: events for rebuilds that produce no
    *      observable change since the last emit are suppressed. See
    *      {@link lastEmittedFingerprint} for the rationale.
    */
   protected dispatchPhaseEvent(document: LangiumDocument, cancelToken: CancellationToken): void {
      if (cancelToken.isCancellationRequested) {
         // Build preempted by a concurrent write lock (or other cancel source) —
         // the subscription event is stale by the time it would fire. Skip
         // emission so RPC subscribers don't surface intermediate states.
         // A pending revert mark is deliberately NOT consumed here: the
         // follow-up build re-fires this phase and broadcasts then.
         return;
      }
      const uri = document.uri.toString();
      // Consume the last-close mark even when subscriptions exist — the
      // regular dispatch below serves those watchers, and the mark's author
      // attribution is more precise than the post-close `UNKNOWN_CLIENT_ID`
      // the author lookup would yield.
      const revertedOnClose = this.pendingRevertBroadcasts.delete(uri);
      if (!this.subscriptions.has(uri) && !revertedOnClose) {
         return;
      }
      const fingerprint = this.computeDocumentFingerprint(document);
      if (this.lastEmittedFingerprint.get(uri) === fingerprint) {
         // A rebuild that produced no observable change since the last emit —
         // suppressed so RPC subscribers don't see a no-op broadcast. Logged at
         // debug so a *needed* re-broadcast wrongly suppressed by this dedup
         // (the failure mode the fingerprint strategy must avoid) is visible.
         this.tracer.withUri(uri).debug(`Suppress onDocumentUpdated v${document.textDocument.version}: fingerprint unchanged`);
         return;
      }
      this.lastEmittedFingerprint.set(uri, fingerprint);
      const event: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic> = {
         document: this.envelope(document.uri),
         sourceClientId: revertedOnClose ? REVERT_ON_CLOSE_CLIENT_ID : this.resolveSourceClientId(document),
         reason: this.resolveUpdateReason(document.uri)
      };
      this.tracer
         .withUri(uri)
         .debug(`Emit onDocumentUpdated v${event.document.version} (reason=${event.reason}, sourceClientId=${event.sourceClientId})`);
      this.clientProxy.onDocumentUpdated(event);
   }

   /**
    * Fingerprint of the document's observable state, used to de-dup
    * `onDocumentUpdated` emissions. The {@link FingerprintStrategy} option
    * selects what is hashed (default `'transfer-document'` — see the type), and
    * {@link additionalFingerprintInputs} folds in any extra adopter signal.
    *
    * The default `'transfer-document'` strategy goes through the encoder's
    * {@link TransferEncoder.toTransferDocument}, which is cached per build —
    * so within one phase event the fingerprint and the subsequently-emitted
    * `envelope` share a single encode walk.
    *
    * Wrapped in {@link Tracer.time} against {@link FINGERPRINT_LOG_AFTER_MS}.
    */
   protected computeDocumentFingerprint(document: LangiumDocument): string {
      return this.tracer.withUri(document.uri.toString()).time(
         'Compute fingerprint',
         () => {
            const base =
               this.options.fingerprintStrategy === 'text-diagnostics'
                  ? textDiagnosticsFingerprint(document)
                  : transferDocumentFingerprint(this.encoder.toTransferDocument(document));
            const extra = this.additionalFingerprintInputs(document);
            return extra.length === 0 ? base : fingerprintHash([base, FINGERPRINT_SEPARATOR, ...extra.map(value => JSON.stringify(value))]);
         },
         'debug',
         { logAfterMs: FINGERPRINT_LOG_AFTER_MS }
      );
   }

   /**
    * Extra inputs folded into {@link computeDocumentFingerprint} alongside the
    * chosen {@link FingerprintStrategy}. Default: none. Override to contribute a
    * signal that lives outside the document's text / root / diagnostics — each
    * entry need only be stable across equivalent emissions and
    * JSON-serialisable.
    */
   protected additionalFingerprintInputs(_document: LangiumDocument): readonly unknown[] {
      return [];
   }

   /**
    * Discriminate the reason for a phase-event-driven update notification.
    * Uses the most recent `DocumentBuilder.onUpdate` snapshot:
    * - URI in the `deleted` list → `'deleted'`
    * - URI in the `changed` list → `'changed'` (the URI was passed to
    *   `documentBuilder.update(changed, deleted)`, which spans `didChange`
    *   text-document events and programmatic `update([uri], [])` calls).
    * - Otherwise → `'rebuilt'` (cascade re-derivation: this URI was rebuilt
    *   because something it depends on changed; its own text wasn't flagged).
    *
    * `'saved'` is NOT emitted from this code path — saves take the dedicated
    * `DataClientProtocol.onDocumentSaved` channel; adopters that want a
    * unified update stream synthesise `'saved'` in their bridge layer.
    */
   protected resolveUpdateReason(uri: URI): TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>['reason'] {
      const last = this.lastBuildUpdate;
      if (last?.deleted.some(deleted => UriUtils.equals(deleted, uri))) {
         return 'deleted';
      }
      if (last?.changed.some(changed => UriUtils.equals(changed, uri))) {
         return 'changed';
      }
      return 'rebuilt';
   }

   /**
    * Subscribe to the project tier's change channel and re-fan registry
    * diffs into per-project wire notifications. The internal
    * `ProjectChangeEvent` carries arrays of added/updated ids plus a
    * removed list of `{ id, snapshot }` pairs; each affected project
    * emits one wire `onProjectsChanged` event so clients react
    * one-at-a-time without walking arrays. `'removed'` dispatches carry
    * the pre-removal snapshot bundled in
    * {@link ProjectChangeEvent.removed} because the registry entry is
    * already gone by the time the event fires.
    *
    * Adopters that warm-load services may want to defer this subscription
    * until {@link waitForReady} resolves (to avoid replaying the initial
    * discovery as a burst of `'added'` events). Override
    * {@link subscribeToProjectManager} on the subclass to gate.
    */
   protected subscribeToProjectManager(): void {
      this.disposables.push(this.services.workspace.ProjectManager.onProjectsChanged(event => this.dispatchProjectChangeEvent(event)));
   }

   /**
    * Fan one internal {@link ProjectChangeEvent} out to per-project wire
    * notifications. Each `removed` entry pairs the id with the pre-removal
    * snapshot needed for the `'removed'` wire payload.
    */
   protected dispatchProjectChangeEvent(event: ProjectChangeEvent<TProject>): void {
      for (const id of event.added) {
         const project = this.services.workspace.ProjectManager.getProjectById(id);
         if (project) {
            this.clientProxy.onProjectsChanged({ project, reason: 'added' });
         }
      }
      for (const id of event.updated) {
         const project = this.services.workspace.ProjectManager.getProjectById(id);
         if (project) {
            this.clientProxy.onProjectsChanged({ project, reason: 'updated' });
         }
      }
      for (const entry of event.removed) {
         this.clientProxy.onProjectsChanged({ project: entry.snapshot, reason: 'removed' });
      }
   }

   /**
    * Resolve the wire-level `sourceClientId` for `document`'s events — the client
    * that authored its current version, from the version-author history on
    * `HydraniumTextDocuments`. The protocol-level counterpart of the internal
    * `AstDocumentManager.getAuthor`: a framework-internal rebuild has no author,
    * so this surfaces the {@link UNKNOWN_CLIENT_ID} presentation default. Adopters
    * that rebuild through non-text-document channels override to derive a
    * source id of their own.
    */
   protected resolveSourceClientId(document: LangiumDocument): string {
      const author = this.services.workspace.TextDocuments.getAuthor(document.textDocument.uri, document.textDocument.version);
      return author ?? UNKNOWN_CLIENT_ID;
   }

   // --- Diagnostics (DataServerDiagnosticsProtocol) ---------------------------
   // Computed in THIS process: the data-server child holds the model store, so
   // these snapshots reflect the heap that actually carries the workspace
   // AST/CST — the process that OOMs. Each is also emitted through the tracer so
   // it reaches the server's log sink (e.g. a pod's stdout) and not only the
   // RPC caller.

   async dumpServerState(args: DumpServerStateArgs): Promise<string> {
      const snapshot = await this.options.diagnostics.dumpServerState(this.services, args);
      this.tracer.info(snapshot);
      return snapshot;
   }

   async writeHeapSnapshot(args: WriteServerHeapSnapshotArgs): Promise<string> {
      const filePath = await this.options.diagnostics.writeHeapSnapshot(args);
      this.tracer.info(`Heap snapshot written to ${filePath}`);
      return filePath;
   }

   async dumpPodMemory(): Promise<string> {
      const snapshot = await this.options.diagnostics.dumpPodMemory();
      this.tracer.info(snapshot);
      return snapshot;
   }

   async startProfiling(args: StartProfilingArgs): Promise<void> {
      // The provider is singleton-guarded (one inspector session per process);
      // a second start rejects there. Hold the capture so stopProfiling can end it.
      const capture = await this.options.diagnostics.startProfiling(args);
      // The connection may have closed (firing dispose) while start() was still
      // awaiting begin(); dispose saw no activeProfile yet, so stop it here rather
      // than leave the inspector singleton wedged for the process lifetime.
      if (this.disposed) {
         await capture.stop({}).catch(() => undefined);
         return;
      }
      this.activeProfile = capture;
      this.tracer.info('Profiling started');
   }

   async stopProfiling(args: StopProfilingArgs): Promise<string> {
      if (!this.activeProfile) {
         throw noActiveProfileError();
      }
      const capture = this.activeProfile;
      this.activeProfile = undefined;
      // Writing the artefacts, folding the window into `server-summary.json` and
      // formatting the report all happen inside the capture: each needs the
      // filesystem, and the report shape they pass between them is Node-side.
      const formatted = await capture.stop(args);
      this.tracer.info(formatted);
      return formatted;
   }

   async getLatency(): Promise<LatencyReport> {
      return this.latency?.report() ?? { windowMs: 0, methods: [] };
   }

   /** Resolve a partial options object into a fully-defaulted form. */
   protected resolveOptions(partial: DataServerOptions): ResolvedDataServerOptions {
      const additionalMethods = partial.additionalMethods ?? [];
      const builtIn = [...DATA_SERVER_PROTOCOL_METHODS, ...DATA_SERVER_DIAGNOSTICS_METHODS] as readonly string[];
      const overlap = additionalMethods.filter(name => builtIn.includes(name));
      if (overlap.length > 0) {
         throw new Error(
            `DataServer.additionalMethods overlaps with built-in data-server methods: ${overlap.join(', ')}. ` +
               'Adopter protocols must not redeclare framework method names; rename the adopter method or remove it from additionalMethods.'
         );
      }
      return {
         subscriptionPhase: partial.subscriptionPhase ?? DataServer.DEFAULT_OPTIONS.subscriptionPhase,
         fingerprintStrategy: partial.fingerprintStrategy ?? 'transfer-document',
         methodNamespace: partial.methodNamespace ?? DATA_SERVER_WIRE_PREFIX,
         additionalMethods,
         excludedMethods: partial.excludedMethods ?? [],
         diagnostics: partial.diagnostics ?? defaultDataServerDiagnostics()
      };
   }
}
