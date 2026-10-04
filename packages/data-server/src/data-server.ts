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
   HYDRANIUM_ERROR_CODES,
   isDocumentSource,
   isElementSource,
   isSyntheticSource,
   messageData,
   messageError,
   ReferenceSource,
   SessionClosedError,
   TIMED_OUT,
   type CloseModelArgs,
   type HydraniumMessageData,
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
   type TransferModelSnapshot,
   type ModelVersion,
   type TextState,
   type Tracer,
   type TransferDiagnostic,
   TransferDocument,
   type TransferSavedDocument,
   type TransferElement,
   UNKNOWN_CLIENT_ID,
   textHash
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
   type CloseSessionArgs,
   type CreateModelDocumentArgs,
   type CreateSessionArgs,
   type GetModelDocumentArgs,
   type GetProjectForUriArgs,
   type TransferPersistDocumentArgs,
   type TransferSaveDocumentArgs,
   type WatchModelDocumentArgs,
   type TransferDocumentSavedEvent,
   type TransferDocumentUpdatedEvent,
   type TransferUpdateDocumentArgs,
   type TransferUpdateDocumentsArgs
} from '@hydranium/protocol/data';
import { REVERT_ON_CLOSE_CLIENT_ID } from '@hydranium/core';
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
export const NO_ACTIVE_PROFILE_CODE = HYDRANIUM_ERROR_CODES.noActiveProfile;

export const noActiveProfileError = (): HydraniumResponseError => messageError(NO_ACTIVE_PROFILE_CODE, NO_ACTIVE_PROFILE);

/**
 * Raised when a reference question's wait for the build exceeds
 * {@link DataServerOptions.referenceSettleTimeoutMs}.
 *
 * A `ResponseError` because a class name does not cross RPC: without the code a
 * wire client cannot tell a wedged build from a reference that resolves to
 * nothing, which is the distinction the wait exists to keep.
 */
export const REFERENCE_SETTLE_TIMEOUT = defineMessage(
   'hydranium/data-server/reference-settle-timeout',
   'The model is still being processed; try again in a moment.'
);

/** See {@link NO_ACTIVE_PROFILE_CODE} for why this is separate from the catalogue code. */
export const REFERENCE_SETTLE_TIMEOUT_CODE = HYDRANIUM_ERROR_CODES.referenceSettleTimeout;

/** The wait's length rides in `data` as `elapsedMs`, for the code that reacts rather than the reader. */
export const referenceSettleTimeoutError = (elapsedMs: number): ResponseError<HydraniumMessageData & { readonly elapsedMs: number }> =>
   new ResponseError(REFERENCE_SETTLE_TIMEOUT_CODE, REFERENCE_SETTLE_TIMEOUT.format(), {
      elapsedMs,
      ...messageData(REFERENCE_SETTLE_TIMEOUT)
   });

import type { DataServerDiagnosticsProvider, DataServerProfileCapture } from './diagnostics-provider.js';
import type {
   ClientSession,
   ClientSessionWriteArgs,
   ClientTextDocumentChangeEvent,
   DocumentDirtyChangedEvent,
   HydraniumLanguageServices,
   LogNameOptions,
   AstDiagnostic,
   AstDocument,
   EncodedTransferDocument,
   ModelService,
   ProjectChangeEvent,
   ServerSharedServices,
   SessionEndCause,
   TransferEncoder
} from '@hydranium/core';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { type AstNode, DocumentState, type LangiumDocument, UriUtils, type URI } from '@hydranium/langium';
import { type CancellationToken, type MessageConnection, ResponseError } from 'vscode-jsonrpc';

/**
 * Domain separator between text and diagnostics inputs of
 * {@link DataServer.computeDocumentFingerprint}'s hash. A single NUL byte is
 * sufficient: the JSON-stringified diagnostics never contain a NUL byte, so
 * the boundary is unambiguous.
 */
const FINGERPRINT_SEPARATOR = '\0';

/**
 * `LSPErrorCodes.ServerCancelled`, with which Langium's document wait rejects
 * for a URI that has no document; `vscode-languageserver-protocol` is not a
 * dependency of this package.
 */
const SERVER_CANCELLED = -32802;

/**
 * A session a data connection registered with a resume token, and how to end
 * it from another connection. See {@link DataServer.resumableSessions}.
 */
export interface ResumableSession {
   readonly token: string;
   /** End the session as its connection closing would. */
   readonly end: () => void;
}

const resumableByModelService = new WeakMap<object, Map<string, ResumableSession>>();

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
 * - `'text-diagnostics'` — the cheaper parsed-text + diagnostics hash. An
 *   opt-DOWN for adopters that fold no derived state and want to avoid
 *   stringifying the transfer root per phase event.
 */
export type FingerprintStrategy = 'transfer-document' | 'text-diagnostics';

/**
 * Hash `text`, the text the model was parsed from, + `model`'s diagnostics — the `'text-diagnostics'` strategy.
 * The text comes from the root's ledger record or CST, as the document's own may have moved on,
 * and a repair in place leaves the CST on the unrepaired text;
 * a root built without a CST hashes as `'transfer-document'`.
 * Absent diagnostics must hash apart from `[]`, as in {@link transferDocumentFingerprint}.
 */
function textDiagnosticsFingerprint(text: string | undefined, model: EncodedTransferDocument<TransferElement, unknown>['model']): string {
   return text === undefined
      ? transferDocumentFingerprint(model)
      : textHash([text, FINGERPRINT_SEPARATOR, JSON.stringify(model.diagnostics ?? null)]);
}

/**
 * Hash an encoded model's root + diagnostics — the `'transfer-document'` strategy.
 * Absent diagnostics must hash apart from `[]`: a client skipping a render on an
 * equal hash would otherwise miss a validation that found nothing.
 */
function transferDocumentFingerprint(model: EncodedTransferDocument<TransferElement, unknown>['model']): string {
   return textHash([JSON.stringify(model.root), FINGERPRINT_SEPARATOR, JSON.stringify(model.diagnostics ?? null)]);
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
    * response phase. A read (`getModelDocument`) settles at the
    * integrity-settled landmark (`IntegrityService.SettledState`), or at
    * `Validated` when {@link GetModelDocumentArgs.includeDiagnostics} is set.
    * A write (`updateModelDocument` / `updateModelDocuments` /
    * `saveModelDocument`) answers once its document is validated, as a
    * session's write does. This option controls only the async notification
    * phase.
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
    * How long a reference question waits for the build to reach `Linked` before
    * failing with {@link REFERENCE_SETTLE_TIMEOUT_CODE}. Bounded because the
    * wait resolves off a build-phase notification, so a build cancelled below
    * `Linked` with nothing after it leaves the request unanswered for the life
    * of the server.
    *
    * Expiry rejects rather than reading the index anyway: the unsettled index
    * is what the wait keeps the caller away from, so falling through to it on a
    * slow build reinstates the fault — and on a name proposal persists it.
    *
    * Default {@link DataServer.DEFAULT_OPTIONS}, sized for a cold workspace
    * still reaching `Linked` for the first time.
    */
   readonly referenceSettleTimeoutMs?: number;

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
    * LSP connection can pass the SAME collector through `lspLatencyOptions` to
    * that connection, so one report covers both heads. Absent by default (no
    * timing overhead).
    */
   readonly latency?: LatencyCollector;
}

/**
 * Fully-resolved variant of {@link DataServerOptions} — every field set, after
 * merging defaults. Returned by the `protected`
 * {@link DataServer.resolveOptions} and held on {@link DataServer.options}, so
 * an adopter changing how defaults resolve has to name it.
 */
export interface ResolvedDataServerOptions {
   readonly subscriptionPhase: DocumentState;
   readonly fingerprintStrategy: FingerprintStrategy;
   readonly methodNamespace: string;
   readonly additionalMethods: readonly string[];
   readonly excludedMethods: readonly string[];
   /** Always resolved — to the caller's, or to the platform default. */
   readonly diagnostics: DataServerDiagnosticsProvider;
   readonly referenceSettleTimeoutMs: number;
}

/**
 * What a {@link DataServer} keeps per canonical URI, in the `protected`
 * {@link DataServer.uriWatchRecords}. A record lives while it has a watcher
 * or a revert mark; {@link DataServer.pruneUriWatchRecord} enforces that on
 * every path that removes either, so a record with no watcher has a revert
 * pending. Test the size of {@link DataServerUriWatchRecord.watchers}, not the
 * record's presence, for "watched".
 */
export interface DataServerUriWatchRecord {
   /** The client ids watching the URI; save, dirty and phase events go out only while it is non-empty, a pending revert aside. */
   readonly watchers: Set<string>;
   /** Digest of the last emitted state, or of the state a first watch found; see {@link DataServer.dispatchPhaseEvent} for why it de-duplicates, {@link DataServer.computeDocumentFingerprint} for its inputs. */
   fingerprint?: string;
   /**
    * The version {@link DataServerUriWatchRecord.fingerprint} was taken at; an
    * event goes out when either moves. Not {@link DataServerUriWatchRecord.sentVersion}:
    * a first watch sets this and sends nothing, so the next event at its
    * version still carries the manager's attribution.
    */
   fingerprintVersion?: ModelVersion;
   /** Set by {@link DataServer.subscribeToTextDocumentCloses}; the next phase event broadcasts even without a watcher. */
   revertPending?: boolean;
   /**
    * The version of an open document the last event sent was built at. The
    * version sent again goes out as `'rebuilt'` from no client: the manager
    * counts a version delivered only once its `Validated` listeners ran, so a
    * build cancelled after the subscription phase would send it as a change
    * twice. Only while the store has the document open: without it, a
    * document can keep one version through changes of its file, so its events
    * keep the manager's attribution.
    */
   sentVersion?: number;
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
 * **`TTransfer` is not checked.** It declares the union of the transfer roots
 * the workspace's languages produce. Which root a document has is known only
 * at runtime, from its language, so a `TTransfer` missing a language compiles.
 *
 * Lifecycle: the constructor registers framework request handlers (plus
 * any names supplied via {@link DataServerOptions.additionalMethods}) and
 * builds the {@link DataClientProtocol} notification proxy on the same
 * connection in one {@link createRpcProxy} call (binding `this` as its
 * `localTarget`) under the configured namespace, and subscribes two listeners
 * at the configured phase: a `DocumentBuilder.onDocumentPhase` one dispatching
 * per-document `clientProxy.onDocumentUpdated` for watched URIs, and a
 * `DocumentBuilder.onBuildPhase` one dispatching a single
 * `clientProxy.onDocumentsBuilt` naming the batch's unwatched documents.
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
   static readonly DEFAULT_OPTIONS: Required<Pick<DataServerOptions, 'subscriptionPhase' | 'referenceSettleTimeoutMs'>> = {
      subscriptionPhase: DocumentState.Validated,
      referenceSettleTimeoutMs: 60_000
   };

   protected readonly options: ResolvedDataServerOptions;
   /** This connection's {@link DataServerUriWatchRecord} per canonical URI; see there for when a record lives. */
   protected readonly uriWatchRecords = new Map<string, DataServerUriWatchRecord>();
   /**
    * The client sessions this connection registered, by client id. A document
    * request carrying one of these ids acts as that session; one carrying any
    * other id fails.
    *
    * Entries stay after {@link dispose} has ended their sessions, so a request
    * still running from before the connection closed reaches the ended handle
    * and fails with the session's own error.
    */
   protected readonly clientSessions = new Map<string, ClientSession<AstNode, AstDiagnostic, TTransfer>>();
   /** Typed client proxy — sends `data-server/on*` notifications back over the same wire. */
   protected readonly clientProxy: DataClientProtocol<TTransfer, TDiagnostic, TProject>;
   protected readonly disposables = new DisposableCollection();
   protected readonly tracer: Tracer;
   /** The in-flight interactive profile capture, held between {@link startProfiling} and {@link stopProfiling}. */
   protected activeProfile?: DataServerProfileCapture;
   /** Set once {@link dispose} has run, so a capture that starts after teardown is stopped instead of leaked. */
   protected disposed = false;
   /** Per-method RPC latency collector, when the head opted in via {@link DataServerOptions.latency}. */
   protected readonly latency?: LatencyCollector;
   /** Encoder pulled from DI. Adopters rebind `services.model.TransferEncoder` to a typed-overlay subclass. */
   protected readonly encoder: TransferEncoder<TDiagnostic>;
   /**
    * In-process workspace facade — the lifecycle delegate `get` / `update` / `save` go through.
    * Its documents carry the AST-layer {@link AstDiagnostic}, never the wire `TDiagnostic`:
    * {@link encoder} converts one into the other on the way out.
    */
   protected readonly modelService: ModelService<AstNode, AstDiagnostic, TTransfer>;

   constructor(
      protected readonly connection: MessageConnection,
      protected readonly services: ServerSharedServices<TProject, TDiagnostic>,
      options: DataServerOptions = {}
   ) {
      this.options = this.resolveOptions(options);
      this.tracer = this.services.Tracer.for(options.logName ?? 'DataServer').trace('instantiated');
      // DI-bound: adopters rebind `services.model.TransferEncoder` /
      // `services.model.ModelService` with their own subclasses.
      const { TransferEncoder: encoder, ModelService: modelService } = this.services.model;
      if (!encoder || !modelService) {
         throw new Error(
            'DataServer requires `services.model.TransferEncoder` and `services.model.ModelService` to be bound. ' +
               'Did you compose `createServerSharedModule(ctx)` into your shared module?'
         );
      }
      this.encoder = encoder;
      this.modelService = modelService;
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
      this.disposables.push(this.services.workspace.DocumentBuilder.onUpdate((_changed, deleted) => this.dispatchDeleteEvents(deleted)));
      this.subscribeToDocumentBuilder();
      this.subscribeToTextDocumentSaves();
      this.subscribeToDirtyChanges();
      this.subscribeToTextDocumentCloses();
      this.subscribeToProjectManager();
      // Self-register teardown so an adopter that keeps no reference to the
      // server still releases per-connection state, with no lifecycle hook of
      // its own. The client did not close anything itself, so its sessions end
      // as lost and each document it was the last to have open waits out the
      // store's revert grace. See `dispose`.
      this.disposables.push(connection.onClose(() => this.dispose('lost')));
   }

   /**
    * Release everything the constructor wired up — the bound protocol
    * handlers and every listener — and clear {@link uriWatchRecords}, so a
    * long-lived shared services bundle does not retain per-connection memory
    * after the connection closes. Also ends every session this connection registered, which closes
    * every document it has open: the SHARED store's state rather than this
    * server's, which outlives the connection unless released here.
    *
    * Idempotent: subsequent calls are no-ops. Runs by itself when the
    * connection closes, so adopters who don't hold a reference still get
    * per-connection cleanup; adopters that DO hold a reference may call
    * `dispose()` directly for early teardown. The sessions end with `cause`:
    * `'closed'` reverts every document whose last open they close at once,
    * and `'lost'`, the connection's own close, lets each wait out the revert
    * grace.
    */
   dispose(cause: SessionEndCause = 'closed'): void {
      this.disposed = true;
      // Release an in-flight interactive capture so the process-wide inspector
      // singleton is not left active after the connection closes.
      if (this.activeProfile) {
         const capture = this.activeProfile;
         this.activeProfile = undefined;
         void capture.stop({}).catch(() => undefined);
      }
      // AFTER `disposables.dispose()`, deliberately: ending a session releases
      // each document it was the last to hold, and this server's own
      // `onDidCloseLastOpen` listener would otherwise mark a revert broadcast
      // for a connection that is already gone.
      this.disposables.dispose();
      for (const [clientId, session] of this.clientSessions) {
         this.endSession(clientId, session, cause);
      }
      this.uriWatchRecords.clear();
   }

   // ============================================================
   // DataServerProtocol implementation
   // ============================================================
   //
   // Reads go to `ModelService`; a request that opens or writes a document
   // goes to the session this connection registered under its `clientId`.
   // Each answer is encoded on the wire boundary via
   // `encoder.astDocumentToTransferDocument`. To change how documents are
   // read, override on the ModelService subclass; to change how they are
   // written, on the session class the bound `ClientSessionFactory` builds.

   async createSession(args: CreateSessionArgs): Promise<void> {
      // After teardown nothing would ever end a session registered now, and its
      // id would stay taken for the life of the process.
      if (this.disposed) {
         throw new SessionClosedError(args.clientId);
      }
      const resumable = this.resumableSessions();
      const previous = resumable.get(args.clientId);
      if (previous && args.resumeToken !== undefined && previous.token === args.resumeToken) {
         previous.end();
      }
      const session = this.modelService.createSession(args.label, args.clientId);
      this.clientSessions.set(args.clientId, session);
      if (args.resumeToken !== undefined) {
         // Taken over by a client registering again after its connection
         // dropped, so the old session ends as lost: the documents it was the
         // last to have open wait out the grace, and the new session's opens
         // find their unsaved text.
         resumable.set(args.clientId, { token: args.resumeToken, end: () => this.endSession(args.clientId, session, 'lost') });
      }
   }

   /**
    * End a session this connection registered. The ended handle stays in
    * {@link clientSessions}, as it does after {@link dispose}, so a request for
    * the id still arriving fails with the ended session's own error.
    */
   async closeSession(args: CloseSessionArgs): Promise<void> {
      const session = this.clientSessions.get(args.clientId);
      if (session) {
         this.endSession(args.clientId, session);
      }
   }

   /** End `session`, registered here under `clientId`, with `cause`, and drop its watches on this connection. */
   protected endSession(
      clientId: string,
      session: ClientSession<AstNode, AstDiagnostic, TTransfer>,
      cause: SessionEndCause = 'closed'
   ): void {
      for (const [uri, record] of this.uriWatchRecords) {
         if (record.watchers.delete(clientId)) {
            this.pruneUriWatchRecord(uri);
         }
      }
      session.dispose(cause);
   }

   /**
    * The resumable sessions of this services tree, by client id, across all of
    * its data connections: a client resumes on another connection than the one
    * that registered it. An entry leaves when its session ends, by any path, so
    * it keeps no ended connection alive.
    *
    * A takeover by resume token ends the old session even when its connection
    * is still alive, so two clients that shared an id and its token would end
    * each other's sessions. And the token is a guard against colliding with a
    * session the server has not yet seen end, not a secret: the wire carries no
    * authentication, and a peer that learns the token can end the session.
    */
   protected resumableSessions(): Map<string, ResumableSession> {
      let sessions = resumableByModelService.get(this.modelService);
      if (!sessions) {
         const created = new Map<string, ResumableSession>();
         // Subscribed once per services tree, and never disposed: it lives as
         // long as the text store it listens to.
         this.services.workspace.TextDocuments.onDidCloseSession(event => created.delete(event.clientId));
         resumableByModelService.set(this.modelService, created);
         sessions = created;
      }
      return sessions;
   }

   async createModelDocument(args: CreateModelDocumentArgs): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      const session = this.requireSession(args.clientId);
      await session.create(args.uri, args.text);
      return this.openedSnapshot(args.uri, () => session.close(args.uri));
   }

   async updateModelDocuments(args: TransferUpdateDocumentsArgs<TTransfer>): Promise<TransferDocument<TTransfer, TDiagnostic>[]> {
      const astDocuments = await this.requireSession(args.clientId).updateAll({
         updates: args.updates.map(update => this.toSessionWrite(update))
      });
      return astDocuments.map(astDocument => this.encodeDocument(astDocument));
   }

   /**
    * The session write a wire write request carries. Only the fields a session
    * takes: a field an adopter adds to a request reaches the session only
    * through an override of this.
    */
   protected toSessionWrite(request: Omit<TransferUpdateDocumentArgs<TTransfer>, 'clientId'>): ClientSessionWriteArgs<TTransfer> {
      return { uri: request.uri, model: request.model, baseVersion: request.baseVersion };
   }

   /**
    * The session this connection registered under `clientId`, which every
    * document request acts as. An id that is not one fails with the
    * closed-session code: opening or writing under it would leave an open that
    * no session end ever closes.
    */
   protected requireSession(clientId: string): ClientSession<AstNode, AstDiagnostic, TTransfer> {
      const session = this.clientSessions.get(clientId);
      if (!session) {
         throw new SessionClosedError(clientId, 'The client session was never registered on this connection.');
      }
      return session;
   }

   async openModelDocument(args: Pick<OpenModelArgs, 'uri' | 'clientId' | 'options'>): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      const session = this.requireSession(args.clientId);
      const wasOpen = this.services.workspace.TextDocuments.isOpenInClient(args.uri, args.clientId);
      await session.open(args.uri, args.options);
      // A repeat open keeps the earlier one, which is still in use.
      return this.openedSnapshot(args.uri, wasOpen ? undefined : () => session.close(args.uri));
   }

   /**
    * The snapshot a session's open or create answers with. When the read
    * fails, `rollback` undoes the open this call made before the failure is
    * rethrown: the caller sees no open, so nothing on its side would ever close
    * it.
    */
   protected async openedSnapshot(uri: string, rollback?: () => Promise<void>): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      try {
         return await this.getModelDocument({ uri });
      } catch (error: unknown) {
         // The open's failure is the one the caller needs, not the cleanup's.
         await rollback?.().catch(() => undefined);
         throw error;
      }
   }

   async closeModelDocument(args: CloseModelArgs): Promise<void> {
      // Through the handle, so a close under an ended session fails as that
      // session's calls do, and a session class's own close is honoured.
      const session = this.requireSession(args.clientId);
      // Closing also releases the watch for (uri, clientId) — a forgotten
      // unwatch would otherwise leak phase-event dispatch until the connection
      // closes. Idempotent: a close without a prior watch is a no-op.
      await this.unwatchModelDocument({ uri: args.uri, clientId: args.clientId });
      await session.close(args.uri);
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
      try {
         return this.encodeDocument(await this.modelService.ensureDocumentState(args.uri, state));
      } catch (error: unknown) {
         // The protocol answers a read of a URI with no document with an
         // envelope that has no model.
         if (this.isMissingDocument(error, args.uri)) {
            return this.envelope(UriUtils.toUri(args.uri));
         }
         throw error;
      }
   }

   async updateModelDocument(args: TransferUpdateDocumentArgs<TTransfer>): Promise<TransferDocument<TTransfer, TDiagnostic>> {
      const astDocument = await this.requireSession(args.clientId).update(this.toSessionWrite(args));
      return this.encodeDocument(astDocument);
   }

   async saveModelDocument(args: TransferSaveDocumentArgs<TTransfer>): Promise<TransferSavedDocument<TTransfer, TDiagnostic>> {
      const astDocument = await this.requireSession(args.clientId).save(this.toSessionWrite(args));
      return { ...this.encodeDocument(astDocument), persisted: astDocument.persisted };
   }

   async persistModelDocument(args: TransferPersistDocumentArgs): Promise<TransferSavedDocument<TTransfer, TDiagnostic>> {
      const astDocument = await this.requireSession(args.clientId).persist({ uri: args.uri, baseVersion: args.baseVersion });
      return { ...this.encodeDocument(astDocument), persisted: astDocument.persisted };
   }

   /**
    * Record a watch for `(uri, clientId)`. Subsequent phase events on `uri`
    * fan out to the wired `clientProxy.onDocumentUpdated`. The
    * bidirectional pattern means the event channel is the client
    * notification surface, not a returned handle — this method only
    * registers the watcher in {@link uriWatchRecords}.
    *
    * Also baselines the URI's emission fingerprint (see
    * {@link dispatchPhaseEvent}) to the document's current state when the
    * first watcher for the URI registers. This guarantees that any phase event firing immediately after
    * the watch with no observable change is suppressed — watchers obtain
    * initial state via `getModelDocument` (or {@link openModelDocument}) and
    * do not need a redundant phase notification for that same state.
    */
   async watchModelDocument(args: WatchModelDocumentArgs): Promise<void> {
      const uri = this.canonicalKey(args.uri);
      const record = this.uriWatchRecords.get(uri) ?? { watchers: new Set<string>() };
      this.uriWatchRecords.set(uri, record);
      record.watchers.add(args.clientId);
      if (record.fingerprint === undefined) {
         const document = this.services.workspace.LangiumDocuments.getDocument(UriUtils.toUri(uri));
         if (document && !this.services.workspace.ModelLedger.isPlaceholder(document.parseResult.value)) {
            record.fingerprint = this.computeDocumentFingerprint(document.parseResult.value, this.encoder.toTransferDocument(document));
            record.fingerprintVersion = this.services.workspace.ModelLedger.versionOf(document.parseResult.value);
         }
      }
   }

   /**
    * Remove a watch for `(uri, clientId)` previously created by
    * {@link watchModelDocument}. Idempotent — unwatching twice is a no-op.
    * Dispatch for `uri` stops once no watchers remain, and the emission
    * fingerprint goes with the last watcher (see {@link pruneUriWatchRecord}).
    */
   async unwatchModelDocument(args: WatchModelDocumentArgs): Promise<void> {
      const uri = this.canonicalKey(args.uri);
      if (this.uriWatchRecords.get(uri)?.watchers.delete(args.clientId)) {
         this.pruneUriWatchRecord(uri);
      }
   }

   /**
    * Drop what `uri` no longer needs: the
    * {@link DataServerUriWatchRecord.fingerprint} once no client watches it,
    * and the whole record once it holds no
    * {@link DataServerUriWatchRecord.revertPending} mark either. Every path
    * that removes a watcher or consumes a mark ends here.
    */
   protected pruneUriWatchRecord(uri: string): void {
      const record = this.uriWatchRecords.get(uri);
      if (!record || record.watchers.size > 0) {
         return;
      }
      if (record.revertPending) {
         record.fingerprint = undefined;
         record.fingerprintVersion = undefined;
      } else {
         this.uriWatchRecords.delete(uri);
      }
   }

   /**
    * Canonicalise a URI string for use as a {@link uriWatchRecords} key, via the
    * shared `DocumentUriPolicy`. Callers may send non-canonical URIs
    * (drive-letter casing, percent-encoding differences, or a symlink path)
    * over the wire; the dispatch side keys by
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

   /**
    * Settle the build before a reference question is answered from the index.
    *
    * A query issued right after a model update otherwise races the rebuild and
    * reads an index missing the symbols it asks about. The cost is not confined
    * to this call: a scope built inside that window is cached, and the build's
    * remaining documents link against it.
    *
    * Waits the source document specifically, but ONLY when one is loaded at
    * that URI: a synthetic source can address a URI with no document (a
    * directory URI, typically), where a per-URI `waitUntil` throws "No document
    * found". Falls back to a global settle, matching the id-based
    * `ElementSource` path.
    *
    * Bounded by {@link DataServerOptions.referenceSettleTimeoutMs}.
    */
   protected async awaitReferencesLinked(source: ReferenceSource): Promise<void> {
      const uri = isDocumentSource(source) || isSyntheticSource(source) ? UriUtils.toUri(source.uri) : undefined;
      const waitUri = uri && this.services.workspace.LangiumDocuments.hasDocument(uri) ? uri : undefined;
      const stopwatch = this.services.Clock.stopwatch();
      const linked = this.services.workspace.DocumentBuilder.waitUntil(DocumentState.Linked, waitUri);
      if ((await this.services.Clock.raceTimer(linked, this.options.referenceSettleTimeoutMs)) !== TIMED_OUT) {
         return;
      }
      const elapsedMs = Math.round(stopwatch.elapsedMs);
      // A per-URI wait resolves off a document-phase notification, so a
      // missed one strands a wait on a document that HAS reached the
      // phase. Re-read before failing; the workspace-wide wait has no
      // equivalent reading and can only reject.
      const document = waitUri ? this.services.workspace.LangiumDocuments.getDocument(waitUri) : undefined;
      if (waitUri && document && document.state >= DocumentState.Linked) {
         this.tracer
            .withUri(waitUri.toString())
            .warn(`Missed the 'Linked' notification after ${elapsedMs}ms; the document already reached it`);
         return;
      }
      throw referenceSettleTimeoutError(elapsedMs);
   }

   async findReferenceCandidates(ctx: ReferenceContext): Promise<ReferenceCandidate[]> {
      await this.awaitReferencesLinked(ctx.source);
      return this.resolveReferenceServices(ctx.source).CandidateProvider.find(ctx);
   }

   async resolveReference<TElement extends TransferElement = TransferElement>(
      ref: ReferenceRequest
   ): Promise<ReferenceTarget<TElement> | undefined> {
      await this.awaitReferencesLinked(ref.source);
      const resolved = this.resolveReferenceServices(ref.source).CandidateProvider.resolveCandidate(ref);
      if (!resolved) {
         return undefined;
      }
      // The caller's claim about the target's type; see `ReferenceServerProtocol.resolveReference`.
      return { ...resolved.candidate, element: this.encoder.toTransfer(resolved.node) as TElement };
   }

   async findNextName(args: FindNextNameArgs): Promise<string> {
      const uri = UriUtils.toUri(args.uri);
      // Route through the same router as every other reference method.
      // `args` carries a URI and an AST type, which is precisely a
      // synthetic source — and the create-element flow driving this method is
      // the one that produces directory URIs, on which a bare
      // `getServices(uri)` throws while `findReferenceCandidates` succeeds.
      const source = ReferenceSource.synthetic(args.uri, args.type, args.language);
      // Mid-rebuild the names of documents not yet re-indexed are absent from
      // the taken set, and the caller PERSISTS what it is handed. Nothing
      // reserves the answer either, so a name is free of the collisions the
      // index knows about and of nothing else — two callers racing get the same
      // proposal, which only uniqueness at the write can catch.
      await this.awaitReferencesLinked(source);
      const nameProvider = this.resolveReferenceServices(source).NameProvider;
      const tier = args.tier ?? 'project';
      if (tier === 'public') {
         return nameProvider.findNextProjectQualifiedName(args.type, args.proposal);
      }
      if (tier === 'local') {
         // Document-scoped uniqueness: the document root is the container. A
         // URI with no document has nothing to collide with, like a document
         // with no root.
         try {
            const document = await this.modelService.ensureDocumentState(args.uri);
            return document.root ? nameProvider.findNextName(args.type, args.proposal, document.root) : args.proposal;
         } catch (error: unknown) {
            if (this.isMissingDocument(error, args.uri)) {
               return args.proposal;
            }
            throw error;
         }
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
    * 0. A {@link isSyntheticSource} naming its own `language` routes there.
    *    First because every step below infers, and an inference must not
    *    override a caller that has said which grammar it means.
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
      if (isSyntheticSource(source) && source.language !== undefined) {
         const declared = registry.getServicesById(source.language);
         if (declared) {
            return declared;
         }
         // Falling through on an UNREGISTERED id rather than failing: the id
         // crosses the wire, so a client built against a head with one more
         // grammar would otherwise lose queries the steps below can answer.
      }
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
         return all[0];
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
    * Whether `error`, from waiting on `uri`'s document, means that `uri` has
    * no document: a URI with neither a file nor text builds nothing, and
    * Langium's wait after the build rejects for want of one, with a
    * `ServerCancelled` response error. Any other failure, such as a read
    * that fails before a document is registered, a cancelled wait or a
    * `ReentrantWriteLockError`, is the caller's to see.
    */
   protected isMissingDocument(error: unknown, uri: string): boolean {
      return error instanceof ResponseError && error.code === SERVER_CANCELLED && this.modelService.getDocument(uri) === undefined;
   }

   /**
    * Build a {@link TransferDocument} envelope from the current document state,
    * delegating root + diagnostic encoding to {@link encoder} (see
    * `TransferEncoder.toTransferDocument` for the walk). `fingerprint` is the
    * caller's {@link computeDocumentFingerprint} of that same state, which
    * spares hashing it twice.
    */
   protected envelope(uri: URI, fingerprint?: string): TransferDocument<TTransfer, TDiagnostic> {
      // Resolve through the model service's canonicalizing gateway rather than
      // reaching into `LangiumDocuments` directly, so a divergent (symlink) URI
      // still finds the document the build keys by its real path — and so the
      // data-server never has to remember to canonicalize this lookup itself.
      const document = this.modelService.getDocument(uri.toString());
      if (!document || this.services.workspace.ModelLedger.isPlaceholder(document.parseResult.value)) {
         // No document — a shaped envelope rather than a throw, so the caller
         // decides policy at its own layer; `model` is optional on the envelope
         // so the compiler forces that decision. Adopters preferring to throw
         // override `envelope`. The builder's unparsed placeholder is no
         // document either: its root parses no text.
         return TransferDocument.absent<TTransfer, TDiagnostic>(uri.toString());
      }
      const encoded = this.encoder.toTransferDocument(document);
      return this.withServerState(encoded, fingerprint ?? this.computeDocumentFingerprint(document.parseResult.value, encoded));
   }

   /**
    * The transfer document a request answers with for `astDocument`, its model
    * hashed and the text stamped on it by {@link withServerState}. Every
    * document a request answers with goes through here, so none goes out
    * without them.
    */
   protected encodeDocument(astDocument: AstDocument<AstNode, AstDiagnostic>): TransferDocument<TTransfer, TDiagnostic> {
      const encoded = this.encoder.astDocumentToTransferDocument(astDocument);
      return this.withServerState(encoded, this.computeDocumentFingerprint(astDocument.root, encoded));
   }

   /**
    * `encoded` with `hash` on its model and the text the server holds for it:
    * the store's while it holds the document, the build's otherwise. The text
    * is read when the document is sent rather than kept with the build: a save
    * changes `text.dirty` without a rebuild, and the store's text moves on before
    * the build that follows it.
    */
   protected withServerState(
      encoded: EncodedTransferDocument<TransferElement, TDiagnostic>,
      hash: string
   ): TransferDocument<TTransfer, TDiagnostic> {
      const text = this.services.workspace.TextDocuments.textState(encoded.uri) ?? this.builtTextState(encoded.uri);
      if (text && text.version > encoded.model.version) {
         this.tracer.withUri(encoded.uri).debug(`Send a model behind its text: model v${encoded.model.version} / text v${text.version}`);
      }
      return {
         uri: encoded.uri,
         // The encoder returns the structural base; `TTransfer` is the adopter's
         // declaration of the roots its languages produce, and nothing checks it.
         model: { ...encoded.model, hash } as TransferModelSnapshot<TTransfer, TDiagnostic>,
         ...(text ? { text } : {})
      };
   }

   /**
    * The text a build read for a document the store never held, which is
    * clean: the store holds every text a client gave it.
    */
   protected builtTextState(uri: string): TextState | undefined {
      const textDocument = this.modelService.getDocument(uri)?.textDocument;
      return textDocument && { version: textDocument.version, hash: textHash(textDocument.getText()), dirty: false };
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
      // The BUILD-phase hook, not the per-document one: this notification is one
      // message per build rather than one per document, and Langium hands the
      // whole batch over here. It also does not fire for a cancelled build,
      // which is what the per-document dispatch has to check by hand.
      this.disposables.push(
         this.services.workspace.DocumentBuilder.onBuildPhase(this.options.subscriptionPhase, built => this.dispatchBuiltEvent(built))
      );
   }

   /**
    * Report the documents that reached {@link DataServerOptions.subscriptionPhase}
    * and that NOBODY on this
    * connection is watching — the ones a client was not told about through
    * {@link dispatchPhaseEvent}, which is gated per URI.
    *
    * **The gap this closes is the one no other source can observe.** A document
    * the client watches, it hears about already. A file changed on disk, the
    * host's own filesystem watcher reports — and on a browser host, where the
    * workspace lives behind this head, an external change cannot happen at all.
    * What is left, and what nothing outside the server can see, is a document
    * rebuilt because something it DEPENDS ON changed: its file never changed, so
    * a filesystem watcher is silent by construction, and it has no subscriber, so
    * the update channel is silent by design. A consumer displaying data derived
    * from that document — a tree label, a decorator — otherwise goes stale with
    * no signal from any source, and repairs itself the moment someone opens the
    * file to investigate, which is what makes it expensive to diagnose later.
    *
    * Payload-free on purpose: URIs only, so a client re-reads what it displays
    * rather than being handed transfer documents it did not ask for. That is the
    * property the watcher gate protects, and it is preserved here by
    * carrying no document rather than by gating the message.
    *
    * Quiet in the common case. Editing a document that an editor has open leaves
    * that URI watched and therefore out of this set, so a build with no
    * dependents produces nothing at all, and workspace initialisation produces
    * nothing because it does not build to this phase. The ceiling is a
    * whole-workspace rebuild at the subscription phase: one message, URIs only.
    *
    * The URI is canonicalised for the same reason {@link uriWatchRecords} is keyed
    * that way, and is untested for the same reason as its twin in
    * {@link dispatchDeleteEvents}: the builder reports URIs out of its own
    * store, so a non-canonical one cannot be produced without a fixture
    * asserting a shape the real system never emits.
    */
   protected dispatchBuiltEvent(built: readonly LangiumDocument[]): void {
      const uris = built
         .map(document => this.canonicalKey(document.uri.toString()))
         .filter(uri => !this.uriWatchRecords.get(uri)?.watchers.size);
      if (uris.length === 0) {
         return;
      }
      this.tracer.debug(`Emit onDocumentsBuilt: ${uris.length} unwatched document(s)`);
      this.clientProxy.onDocumentsBuilt({ uris });
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

   /** Relay each change of a document's dirty state; see {@link dispatchDirtyEvent}. */
   protected subscribeToDirtyChanges(): void {
      this.disposables.push(this.services.workspace.TextDocuments.onDidChangeDirty(event => this.dispatchDirtyEvent(event)));
   }

   /**
    * Send a dirty flip to the connection, gated on the URI's watchers as
    * {@link dispatchSaveEvent} is: the answer at any one moment travels on
    * every document sent, so a client that watches nothing reads it there.
    */
   protected dispatchDirtyEvent(event: DocumentDirtyChangedEvent): void {
      const uri = this.canonicalKey(event.uri);
      if (this.uriWatchRecords.get(uri)?.watchers.size) {
         this.clientProxy.onDocumentDirtyChanged({ uri, text: event.text });
      }
   }

   /**
    * Mark each document the store releases after its last close, so
    * {@link dispatchPhaseEvent} broadcasts the following rebuild even without
    * a watcher. The store rebuilds such a document from its disk content,
    * discarding unsaved in-session edits, and the last close typically also
    * removed the last watcher: without the broadcast, a consumer that only
    * ever fetches via `getModelDocument` keeps showing the discarded state.
    * The broadcast is de-duplicated against the fingerprint while a watcher
    * holds one, so a close whose disk state equals the last emitted state
    * stays silent; with no watcher there is no fingerprint, and every revert
    * is sent.
    *
    * A release, not the close itself: a document whose last client lost its
    * connection is released only once the revert grace runs out, or when
    * another client opens it meanwhile, and not at all when a client lost
    * from it opens it again within its own grace.
    */
   protected subscribeToTextDocumentCloses(): void {
      this.disposables.push(
         this.services.workspace.TextDocuments.onDidCloseLastOpen(event => {
            const uri = this.canonicalKey(event.uri);
            const record = this.uriWatchRecords.get(uri) ?? { watchers: new Set<string>() };
            record.revertPending = true;
            this.uriWatchRecords.set(uri, record);
         })
      );
   }

   /**
    * Fan out a deletion for each removed URI, to EVERY client on the connection
    * rather than only to the ones watching that URI.
    *
    * **Deliberately ungated, where {@link dispatchPhaseEvent} and
    * {@link dispatchSaveEvent} are gated.** Those two carry a built document and
    * fire on every build, so the watcher gate is what keeps bandwidth
    * proportional to what a client asked for. A deletion is neither: it is one
    * URI, it is rare, and it reports the workspace's STRUCTURE rather than a
    * document's content. Gating it forces any consumer that displays the
    * workspace — a model tree, a file decorator — to learn about disappearances
    * from a filesystem watcher instead, which a client hosted in a browser has
    * no way to run: its workspace lives behind the head. A client that does not
    * care filters on the URI, which costs it a comparison.
    *
    * The precedent is the last-close revert broadcast (see
    * {@link subscribeToTextDocumentCloses}), where the same judgement was already made
    * in the other direction: a transition that matters enough is delivered
    * without a subscription.
    *
    * Runs from the `DocumentBuilder.onUpdate` listener rather than from a phase
    * listener, which is the only place a deletion is observable: `update`
    * removes the document before deriving the rebuild set, so it is never built.
    * That ordering also puts this notification ahead of the `'rebuilt'` events
    * for the dependents whose references the deletion just broke.
    *
    * The `deleted` list arrives already expanded to concrete document URIs —
    * `deleteDocuments` resolves a directory URI to the documents beneath it — so
    * no caller has to handle a directory here.
    *
    * The URI's fingerprint and revert mark are dropped: they describe a
    * document that no longer exists. A kept fingerprint is adopted as the
    * baseline and suppresses the first emit after the file returns with its
    * previous content.
    *
    * The watchers SURVIVE: a recreated file resumes delivering to them with no
    * re-subscription, and a client that answers the deletion by closing
    * releases the watch through `closeModelDocument` anyway.
    */
   protected dispatchDeleteEvents(deleted: readonly URI[]): void {
      for (const removed of deleted) {
         const uri = this.canonicalKey(removed.toString());
         const record = this.uriWatchRecords.get(uri);
         if (record) {
            record.fingerprint = undefined;
            record.fingerprintVersion = undefined;
            record.revertPending = undefined;
            record.sentVersion = undefined;
            this.pruneUriWatchRecord(uri);
         }
         this.clientProxy.onDocumentDeleted({ uri });
      }
   }

   /** Fan out a save event for the document's URI, gated on the URI's watchers. */
   protected dispatchSaveEvent(event: ClientTextDocumentChangeEvent<TextDocument>): void {
      // The save event arrives under the CLIENT URI the text store keys by (e.g. a
      // symlink path S); `uriWatchRecords` and `dispatchPhaseEvent` key by the
      // CANONICAL identity R. Canonicalize before both the gate and the envelope so
      // a save of a symlinked file isn't silently dropped (and the envelope resolves
      // the R-keyed document rather than missing into an empty one).
      const uri = this.canonicalKey(event.document.uri);
      if (!this.uriWatchRecords.get(uri)?.watchers.size) {
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
    * An event for a URI no client watches is NOT sent over the wire, so
    * bandwidth scales with watched URIs rather than with phase events; a
    * pending revert mark is the exception (see
    * {@link subscribeToTextDocumentCloses}).
    *
    * An event for a rebuild with no observable change since the last emit is
    * suppressed against the URI's fingerprint and the version it was taken at;
    * a new version with the same fingerprint goes out with the same
    * `model.hash`, so a watcher still learns the version. Such rebuilds are routine: a
    * second client attaching to an open document makes
    * `HydraniumTextDocuments.refreshContent` fire `onDidChangeContent` purely
    * to re-trigger the build, and Langium rebuilds a document when a
    * dependency changes even if its diagnostics come out the same. Sent at a
    * version this head has not sent, they reach watchers as `'changed'`, and a
    * watcher that reads `'changed'` as another client's write and resets its
    * root to the server view loses the user's edits. The first {@link watchModelDocument} baselines the
    * fingerprint, so the first event after a watch is de-duplicated against
    * the state the watcher just fetched; it goes with the last watcher, so the
    * next first watch re-baselines rather than adopting a stale digest. A
    * digest keeps its memory constant in document size; see
    * {@link computeDocumentFingerprint} for the inputs.
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
      const record = this.uriWatchRecords.get(uri);
      const revertedOnClose = record?.revertPending === true;
      if (!record || (record.watchers.size === 0 && !revertedOnClose)) {
         return;
      }
      if (revertedOnClose) {
         // Consumed even when watchers exist — the regular dispatch below
         // serves them, and the mark's attribution is more precise than the
         // post-close unknown client the manager's attribution would yield.
         // With no watcher the record goes now, so the fingerprint written
         // below lands on a detached record and the next first watch
         // re-baselines instead of adopting it.
         record.revertPending = undefined;
         this.pruneUriWatchRecord(uri);
      }
      const fingerprint = this.computeDocumentFingerprint(document.parseResult.value, this.encoder.toTransferDocument(document));
      const stamped = this.services.workspace.ModelLedger.versionOf(document.parseResult.value);
      if (record.fingerprint === fingerprint && record.fingerprintVersion === stamped) {
         // A rebuild that produced no observable change since the last emit —
         // suppressed so RPC subscribers don't see a no-op broadcast. Logged at
         // debug so a *needed* re-broadcast wrongly suppressed by this dedup
         // (the failure mode the fingerprint strategy must avoid) is visible.
         this.tracer.withUri(uri).debug(`Suppress onDocumentUpdated v${stamped}: fingerprint and version unchanged`);
         return;
      }
      record.fingerprint = fingerprint;
      record.fingerprintVersion = stamped;
      // The manager's attribution, so this head names the same client as the
      // in-process heads do for one build, except for a version this head
      // already sent; see `DataServerUriWatchRecord.sentVersion`.
      const version = this.services.workspace.AstDocumentManager.isOpen(uri) ? document.textDocument.version : undefined;
      const { reason, sourceClientId } =
         version !== undefined && record.sentVersion === version
            ? { reason: 'rebuilt' as const, sourceClientId: UNKNOWN_CLIENT_ID }
            : this.services.workspace.AstDocumentManager.attributeUpdate(document);
      record.sentVersion = version;
      const event: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic> = {
         document: this.envelope(document.uri, fingerprint),
         sourceClientId: revertedOnClose ? REVERT_ON_CLOSE_CLIENT_ID : sourceClientId,
         reason
      };
      this.tracer.withUri(uri).debug(`Emit onDocumentUpdated v${stamped} (reason=${event.reason}, sourceClientId=${event.sourceClientId})`);
      this.clientProxy.onDocumentUpdated(event);
   }

   /**
    * Fingerprint of the snapshot `root` and its encoding `encoded`, used to
    * de-dup `onDocumentUpdated` emissions and sent as every document's
    * `model.hash`, so it must not depend on the version or on live state. The
    * {@link FingerprintStrategy} option selects what is hashed (default
    * `'transfer-document'` — see the type).
    *
    * {@link TransferEncoder.toTransferDocument} is cached per build, so within
    * one phase event the fingerprint and the subsequently-emitted `envelope`
    * share a single encode walk.
    *
    * Wrapped in {@link Tracer.time} against {@link FINGERPRINT_LOG_AFTER_MS}.
    */
   protected computeDocumentFingerprint(root: AstNode, encoded: EncodedTransferDocument<TransferElement, TDiagnostic>): string {
      return this.tracer
         .withUri(encoded.uri)
         .time(
            'Compute fingerprint',
            () =>
               this.options.fingerprintStrategy === 'text-diagnostics'
                  ? textDiagnosticsFingerprint(this.services.workspace.ModelLedger.textOf(root), encoded.model)
                  : transferDocumentFingerprint(encoded.model),
            'debug',
            { logAfterMs: FINGERPRINT_LOG_AFTER_MS }
         );
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
      const builtIn: readonly string[] = [...DATA_SERVER_PROTOCOL_METHODS, ...DATA_SERVER_DIAGNOSTICS_METHODS];
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
         diagnostics: partial.diagnostics ?? defaultDataServerDiagnostics(),
         referenceSettleTimeoutMs: partial.referenceSettleTimeoutMs ?? DataServer.DEFAULT_OPTIONS.referenceSettleTimeoutMs
      };
   }
}
