/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type CanonicalUri,
   defineMessage,
   type MaybeObservableValue,
   type MaybePromise,
   ObservableValue,
   TIMED_OUT,
   type TransferElement,
   type Tracer
} from '@hydranium/protocol';
import { type AstNode, DocumentState, type LangiumDocument, UriUtils, type URI } from '@hydranium/langium';
import { type AstDiagnostic } from '../validation/document-validator.js';
import { type DocumentUriPolicy } from '../workspace/document-uri-policy.js';
import { ReentrantWriteLockError, isInsideWriteLock } from '../workspace/write-lock-scope.js';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { AstDocument, type AstDocumentSavedEvent, type AstDocumentUpdatedEvent } from '../../documents/ast-document-manager.js';
import { isConnectionGoneError } from '../../util/connection-liveness.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { IntegrityService } from '../integrity/integrity-service.js';
import { labelPhaseListener } from '../document-builder/labeled-phase-listener.js';
import { LANGUAGE_CLIENT_ID } from '../../documents/client-ids.js';
import { type OpenOptions } from '../../documents/client-session-registry.js';
import { type ServerSharedServices } from '../module.js';
import { type ClientSession } from './client-session.js';

/**
 * The undo-stack entry for a server-authored write pushed to the editor.
 *
 * **A user-facing LABEL, not a log string**, which is easy to miss because it
 * travels as an options field rather than as a message: LSP specifies
 * `ApplyWorkspaceEditParams.label` as "presented in the user interface for
 * example on an undo stack to undo the workspace edit". So a user who edits
 * through a form or drags a diagram node reads this in their editor's undo menu
 * — which is why it is rendered like any other message the server sends rather
 * than left as the English literal it was.
 *
 * Parameterless deliberately. The obvious improvement is to name the document,
 * and it is the wrong one: an undo menu is already grouped under the file, so
 * the URI would be noise in the one place it is redundant.
 */
export const MODEL_UPDATE_EDIT = defineMessage('hydranium/core/model-update-edit', 'Update Model');

/** Max time {@link DefaultModelService.settleSave} waits for the build to settle and the sync chain to drain. */
const SAVE_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Constructor options for {@link ModelService}. All fields are optional,
 * and the defaults are the behaviour described on each one.
 */
export interface ModelServiceOptions extends LogNameOptions {
   /**
    * Serialise the facade's own build under the workspace WRITE lock, through
    * `HydraniumDocumentBuilder.scheduleUpdate` as the LSP update handler
    * builds. Default `true`.
    *
    * **Why it defaults on.** Unlocked, the facade's build races the LSP bridge's
    * build of the same URI — both are legitimate (the bridge exists only under a
    * `Connection`, so the facade stands in for it headless), but nothing
    * serialises them, so both run a full validation pass and Langium appends the
    * second onto the first. Every diagnostic is then duplicated, and the
    * duplication compounds per rebuild. Serialised, the second request shares
    * the first build where it carries both, so the redundant work goes too.
    *
    * **What `false` costs.** The facade's build is then unserialised and can run
    * concurrently with the bridge's build of the same URI, so the affected
    * documents are validated twice per write — double the validation work.
    * Reported diagnostics stay correct even then, because
    * `HydraniumDocumentBuilder.dedupeDiagnostics` collapses the byte-identical
    * duplicates a repeated pass produces before any listener sees them; what this
    * option removes is the wasted pass, not just its visible symptom.
    *
    * **What `false` buys.** `WorkspaceLock` is not reentrant. A caller that
    * reaches a session's `update` / `save` or `rebuild` while already holding
    * the write lock — an integrity rule or build-phase pass that writes
    * back — deadlocks: acquiring the lock cancels the running holder, and the new
    * acquisition then waits for that holder to release while the holder waits
    * for this call. On `true` that shape is DETECTED and rejected with
    * {@link ReentrantWriteLockError} rather than hanging, wherever a host
    * installs a write-lock scope tracker (`@hydranium/core/node` does at entry
    * load; see {@link isInsideWriteLock}). Setting `false` is the escape hatch
    * for an adopter whose reentrant shape is unavoidable: the facade's own
    * build then takes no lock, so it cannot cancel the holder it runs inside.
    * The wait after it can still hang there, because a document no build will
    * carry is re-queued through the lock, and that re-queue waits for the
    * holder to end. Prefer `false` over serialised builds only in that case.
    *
    * Accepts a {@link MaybeObservableValue} so it can be bound to a setting and
    * flipped without a restart.
    */
   readonly serializeBuilds?: MaybeObservableValue<boolean>;
}

/**
 * The seam every non-LSP head talks to: the data server, the GLSP head and an
 * adopter's own services reach documents through this slot rather than through
 * the workspace stores.
 *
 * In-process facade over the framework's document plumbing
 * (`HydraniumTextDocuments`, `LangiumDocuments`,
 * `DocumentBuilder`, `WritableFileSystemProvider`). Owns the document
 * lifecycle the data-server and GLSP heads delegate to — client sessions that
 * open, update, save and close documents, the phase reads, and `ready` — so
 * coordinating those primitives doesn't have to be re-implemented per head.
 * Every open and write goes through a session from {@link createSession}.
 *
 * "Model" here means the parsed AST — distinct from the wire-shape
 * `TransferDocument` in `@hydranium/protocol`.
 *
 * **Why a facade**
 *
 * Multiple in-process consumers want the same workspace-level
 * operations:
 * - The data-server head turns these into typed RPC methods.
 * - The GLSP head uses the same lifecycle for diagram-driven edits: GModel
 *   operation handlers write through the diagram's session and wait on phases
 *   before reading.
 * - Server-internal callers (integrity service, ad-hoc bridges, tests)
 *   want the same operations without the wire serialisation step.
 *
 * Coordinating the primitives per-head drifts between heads — different
 * superseded-version handling, different settled-phase choices, different
 * content-change paths. The facade collapses that duplication and gives
 * adopters one extension surface — {@link rewriteModel},
 * {@link serialize} — to customise the in-process behaviour without
 * re-implementing the plumbing.
 *
 * **Read-latest supersession**
 *
 * A session's default `update` and `save` use Langium's per-URI
 * `DocumentBuilder.waitUntil` to wait for `Validated` (the integrity-settled
 * landmark {@link IntegrityService.SettledState} when rebuilds do not
 * validate), then read the post-build state. Concurrent in-process callers
 * on the same URI all see the latest post-build snapshot — none deadlock
 * waiting for a specific version's settled event. Adopters wanting strict
 * version-matched semantics (resolve with vN's snapshot specifically, log
 * "vN superseded by vM at vN+1") override
 * `DefaultClientSession.updateDocument` to attach a phase-listener with
 * explicit version checks; the framework default doesn't need it for safety.
 *
 * **Returns AST snapshots, not wire envelopes**
 *
 * The facade returns {@link AstDocument} (the in-process AST-typed
 * envelope), not `TransferDocument` (the lossy wire shape). In-
 * process callers consume `$container` / `Reference<T>` directly;
 * encoding-on-return would be wasteful and would force the wire-side
 * lossy `$refText` shape on every consumer. The wire-side caller
 * (`DataServer.updateModelDocument` etc.) encodes once on return via
 * the injected `TransferEncoder` — symmetric with the
 * `getModelDocument` envelope path.
 *
 * **Subscriptions** ({@link onModelUpdated} / {@link onModelSaved} /
 * {@link onClientClosed}) are thin pass-throughs over
 * `DocumentBuilder.onDocumentPhase` and
 * `HydraniumTextDocuments.onDidSave` / `onDidClose`. Filtering
 * by URI happens here so consumers can subscribe per-document without
 * implementing the URI gate at each callsite.
 *
 * **Two families, and the distinction matters more than the names suggest.**
 * `waitFor*` is a pure wait — it never triggers a build, so a caller waiting on
 * a document no build has touched waits until something else builds it.
 * `ensureDocumentState` and the phase shorthands over it *dispatch*: warm
 * documents are awaited, cold ones are built.
 *
 * **Diagnostics are typed `never` below `Validated`.** Validation is the last
 * phase, so at any earlier landmark the array either is not yet computed or
 * still holds the previous build's, and reading it would take stale results
 * for fresh ones. A caller that needs diagnostics asks for {@link validated}.
 *
 * What the `never` buys, exactly: reading a field off an element is a compile
 * error, and nothing can be appended. It does NOT stop a caller assigning an
 * element to a typed variable, because `never` is assignable to everything — so
 * this is a guard against reaching for diagnostics by accident, not a seal
 * against doing it deliberately.
 *
 * The waits resolve at or ABOVE their target, so an already-validated document
 * does carry usable diagnostics and the `never` over-forbids there. That
 * direction is the safe one: the alternative permits stale reads silently. A
 * member taking a phase as a PARAMETER cannot judge statically and so returns
 * `TDiagnostic`, leaving the choice to the caller.
 *
 * **Generic parameters.**
 * - `TAst` — the AST root type each consumer expects on the returned
 *   {@link AstDocument}. Constrained to {@link AstNode}.
 * - `TDiagnostic` — the AST-layer diagnostic: whatever the build left on
 *   `LangiumDocument.diagnostics`, carried through on the returned
 *   {@link AstDocument}. Defaults to {@link AstDiagnostic}.
 *   **Not the `TransferEncoder`'s parameter of the same name**, which is
 *   that encoder's OUTPUT and so names the wire shape. This one names its
 *   input, and an adopter binds the two to different types.
 * - `TTransfer` — transfer-model root a session's `update` / `save` accept
 *   args. Constrained to {@link TransferElement}. Defaults to the
 *   structural base.
 */
export interface ModelService<
   TAst extends AstNode,
   TDiagnostic extends AstDiagnostic = AstDiagnostic,
   TTransfer extends TransferElement = TransferElement
> {
   /**
    * Resolves once the workspace has been initialised and its first build has
    * completed — the gate every read should wait behind, since a document
    * queried before it may be unbuilt and reach no phase.
    *
    * A property rather than a method, matching `ProjectManager.ready` and
    * Langium's `WorkspaceManager.ready`. An implementation needing a stricter
    * gate supplies a Promise that awaits its own concern as well.
    */
   readonly ready: Promise<void>;

   // Pure waits — never trigger a build.
   waitForDocumentState(uri: string, state: DocumentState, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;
   waitForDocumentSettled(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>>;
   waitForBuilderState(state: DocumentState, cancelToken?: CancellationToken): Promise<void>;

   // Wait if warm, build if cold.
   ensureDocumentState(uri: string, state?: DocumentState, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;
   rebuild(uri: string, state?: DocumentState, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;
   parsed(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>>;
   linked(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>>;
   settled(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>>;
   indexed(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>>;
   validated(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;

   isOpen(uri: string): boolean;
   snapshot(uri: string): AstDocument<TAst, TDiagnostic> | undefined;
   /**
    * The text a session's write of `model` to `uri` applies: a textual model
    * as given, a structured one rewritten and serialised.
    */
   modelToText(uri: string, model: TTransfer | string, cancelToken?: CancellationToken): Promise<string>;
   getDocument(uri: string): LangiumDocument | undefined;

   onModelUpdated(uri: string, listener: (event: AstDocumentUpdatedEvent<TAst, TDiagnostic>) => void): Disposable;
   onModelSaved(uri: string, listener: (event: AstDocumentSavedEvent<TAst, TDiagnostic>) => void): Disposable;
   onClientClosed(uri: string, clientId: string, listener: () => void): Disposable;

   /**
    * Start a client session, the only way to open and write documents through
    * this service. Pass a `label` naming the participant; without one it is
    * `session`. The id defaults to `label#` plus a random UUID; a fixed
    * `clientId` is taken as given. Throws `ReservedClientIdError` when the id
    * is reserved by the framework, and `DuplicateClientIdError` when it is
    * held by another live session or has documents open under it as a client
    * that is not a session.
    *
    * `TOpenOptions` types the options the session's `open` takes and its
    * `openOptions` returns. The narrowing is an unchecked cast, and it holds
    * only for the caller that started the session: a holder reached through
    * {@link getSession} sees plain `OpenOptions`.
    */
   createSession<TOpenOptions extends OpenOptions = OpenOptions>(
      label?: string,
      clientId?: string
   ): ClientSession<TAst, TDiagnostic, TTransfer, TOpenOptions>;
   /** The live session started under `clientId`, or `undefined` once it has ended or was never started. */
   getSession(clientId: string): ClientSession<TAst, TDiagnostic, TTransfer> | undefined;
}

export class DefaultModelService<
   TAst extends AstNode,
   TDiagnostic extends AstDiagnostic = AstDiagnostic,
   /**
    * Structured payload a session's `update` / `save` accept. Constrained to
    * {@link TransferElement} — the minimal `{ readonly $type: string }`
    * shape. Both transfer-model overlay roots (which extend
    * `TransferElement` explicitly) and AST root types (which have
    * `$type: string` as a required `AstNode` field) satisfy the
    * constraint, so in-process callers (e.g. GLSP state or an
    * integrity service) that pass AST roots remain compatible.
    */
   TTransfer extends TransferElement = TransferElement
> implements ModelService<TAst, TDiagnostic, TTransfer> {
   protected readonly tracer: Tracer;
   /**
    * The single document-identity seam (`services.workspace.DocumentUriPolicy`),
    * cached for the public doors that canonicalize an incoming URI once before
    * threading the resulting {@link CanonicalUri} through the internal cores. A
    * field reference to the shared service, NOT a `canonicalUri` wrapper method —
    * the wrapper was deliberately removed so canonicalisation has a single policy
    * (see {@link DocumentUriPolicy}).
    */
   protected readonly uriPolicy: DocumentUriPolicy;
   /** See {@link ModelServiceOptions.serializeBuilds}. Defaults to `true`. */
   protected readonly serializeBuilds: ObservableValue<boolean>;

   /**
    * Per-URI applyEdit coalescing: at most one in-flight `applyEditToLanguageClient`
    * RPC per URI, newest text wins. A newer settle while the current RPC is in
    * flight overwrites {@link pendingSync}; the chain picks up the latest on its
    * next iteration so the shadow never drifts from Monaco.
    */
   protected readonly syncChains = new Map<string, Promise<void>>();
   protected readonly pendingSync = new Map<string, string>();

   /** The live sessions this service started, by client id, for {@link getSession}. */
   protected readonly sessions = new Map<string, ClientSession<TAst, TDiagnostic, TTransfer>>();
   /**
    * Drops an ended session from {@link sessions}. Subscribed by the first
    * {@link createSession} rather than at construction, so a services tree with
    * no text store, or one that knows nothing of sessions, still constructs
    * this service.
    */
   protected sessionCloseListener?: Disposable;

   /**
    * Workspace-level readiness gate. Resolves when the framework has
    * finished its first workspace build cycle and the `ModelService`
    * methods will behave predictably: per-URI waits resolve, queries
    * return current snapshots, and the build pipeline is driving
    * documents through phases.
    *
    * The default delegates to
    * `services.workspace.WorkspaceManager.workspaceInitialized`, NOT to
    * Langium's `WorkspaceManager.ready`. The difference is load-bearing:
    * Langium resolves `ready` inside `performStartup`, once the workspace
    * documents have been created but BEFORE `documentBuilder.build` runs, so
    * `ready` does not mean "the first build cycle finished". A caller that
    * gated a write on it could land that write mid-initial-build, where two
    * things go wrong at once — the write's `WorkspaceLock.write` cancels the
    * initial build, and the cancelled build's non-validating options are then
    * inherited by the write's own build (see
    * `HydraniumDocumentBuilder.prepareBuild`), so cross-document dependents
    * are silently never validated. `workspaceInitialized` resolves after
    * `initializeWorkspace` completes, build included, which is what this
    * gate has always claimed to mean.
    *
    * Adopters that need a stricter gate (post-warm-load, AI model
    * initialised, plugin warm-up) rebind the slot with a subclass and replace
    * this field with a Promise that awaits both the workspace and the extra
    * concern.
    *
    * Property (not method) — matches `ProjectManager.ready` and Langium's
    * `WorkspaceManager.ready` conventions; the shape difference signals
    * "in-process readiness" vs the wire-side `DataServer.waitForReady()`
    * method (RPC operation).
    */
   readonly ready: Promise<void>;

   constructor(
      protected readonly services: ServerSharedServices,
      options: ModelServiceOptions = {}
   ) {
      this.tracer = services.Tracer.for(options.logName ?? 'ModelService').trace('instantiated');
      this.uriPolicy = services.workspace.DocumentUriPolicy;
      this.serializeBuilds = ObservableValue.from(options.serializeBuilds ?? true);
      // Optional-chain so a harness that binds no WorkspaceManager awaits
      // `undefined` and resolves immediately; production hosts always have it
      // bound.
      // Deliberately NO fallback to Langium's `ready`: it resolves pre-build,
      // so falling back to it would silently reinstate the very gap this gate
      // exists to close.
      // Captured rather than read off `this` inside the closure, which TS cannot
      // prove runs after the field is assigned.
      const tracer = this.tracer;
      this.ready = (async () => {
         try {
            await services.workspace.WorkspaceManager?.workspaceInitialized;
         } catch (error: unknown) {
            // NEVER rejects, deliberately. This gate is about TIMING — "the
            // initial build has finished" — not about whether it succeeded, and
            // Langium's `ready` (what it replaced) could not reject at all.
            // `workspaceInitialized` can: it rejects on a cancelled initial
            // build (routine — any write preempts one) and on a failed one
            // (e.g. a disposed connection at teardown). Propagating either would
            // fail every `waitForReady` for the rest of the process lifetime,
            // a far worse failure than the late gate this exists to fix.
            tracer.debug(`Initial workspace build did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`);
         }
      })();
      // One persistent listener mirroring non-LSP-client changes back to the LSP
      // textual language client. Fires per document as it reaches the
      // post-integrity settled phase (post-integrity, pre-validation) so editors
      // converge as soon as cross-references resolve. Self-healing: it re-derives
      // the sync decision from the current settled state every time, so a doc
      // that needs syncing on a later settle (re-open refresh, recovery build) is
      // caught even though an earlier settle already synced it. See
      // `syncToLanguageClient`.
      this.services.workspace.DocumentBuilder.onDocumentPhase(
         IntegrityService.SettledState,
         labelPhaseListener(document => this.syncToLanguageClient(document), 'ModelService.syncToLanguageClient')
      );
   }

   // ============================================================
   // Lifecycle (public API)
   // ============================================================

   /**
    * Wait for the document at `uri` to reach `state`. Pure wait — does
    * not trigger a build. If `uri` is not yet in the document registry
    * the call will hang until something else drives it through the
    * pipeline; for the cold-start case use {@link rebuild} instead.
    *
    * Wrapped in a debug-level timing log via {@link Tracer.time} so
    * slow per-URI waits surface in build telemetry; the URI is
    * attached via {@link Tracer.withUri} for callsite attribution.
    */
   async waitForDocumentState(uri: string, state: DocumentState, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      return this.waitForDocumentStateCanonical(this.uriPolicy.canonicalUri(uri), state, cancelToken);
   }

   /**
    * Wait for the document at `uri` to reach the integrity-settled landmark
    * ({@link IntegrityService.SettledState}) — the earliest phase at which the
    * AST + serialised text are stable post-integrity. Convenience wrapper over
    * {@link waitForDocumentState} for the common "wait until content is stable"
    * case (e.g. settling a save). Pure wait — does not trigger a build.
    */
   async waitForDocumentSettled(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return (await this.waitForDocumentStateCanonical(
         this.uriPolicy.canonicalUri(uri),
         IntegrityService.SettledState,
         cancelToken
      )) as AstDocument<TAst, never>;
   }

   /**
    * Internal wait core operating on an already-{@link CanonicalUri canonical}
    * URI. The public string doors ({@link waitForDocumentState} /
    * {@link waitForDocumentSettled}) and the build/ensure cores
    * ({@link rebuildCanonical} / {@link ensureDocumentStateCanonical}) canonicalize
    * once at entry and thread the result here, so a single high-level op resolves
    * the identity once instead of re-running the (filesystem-touching) `realpath`
    * at every wait. The `CanonicalUri` parameter type enforces that — a raw
    * `string` cannot be passed without minting through the URI policy.
    */
   protected async waitForDocumentStateCanonical(
      uri: CanonicalUri,
      state: DocumentState,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>> {
      const documentUri = UriUtils.toUri(uri);
      await this.tracer
         .withUri(uri)
         .time(
            `Wait for document state '${DocumentState[state]}'`,
            () => this.services.workspace.DocumentBuilder.waitUntil(state, documentUri, cancelToken),
            'debug'
         );
      return this.toAstDocument(documentUri);
   }

   /**
    * Wait for the document builder to reach `state` across its currently-
    * queued documents. Pure wait — does not trigger a build. Used by
    * shutdown / cascade-rebuild observers / tests; per-URI callers
    * should use {@link waitForDocumentState} instead.
    *
    * Timing log fires on the unattributed logger (no URI scope, since
    * the wait spans the whole build queue).
    */
   async waitForBuilderState(state: DocumentState, cancelToken?: CancellationToken): Promise<void> {
      await this.tracer.time(
         `Wait for builder state '${DocumentState[state]}'`,
         () => this.services.workspace.DocumentBuilder.waitUntil(state, cancelToken),
         'debug'
      );
   }

   /**
    * Force a fresh build of the document at `uri` and wait for it to
    * reach `state` (or the integrity-settled landmark
    * {@link IntegrityService.SettledState} if omitted).
    * Always builds the document, whether or not it is already in the
    * registry, in a build of its own or in one already scheduled that carries
    * it — call this when you want to re-process from scratch.
    *
    * The facade is responsible for requesting the build itself because Langium's `DefaultDocumentUpdateHandler.didChangeContent`
    * (the standard text-document → builder bridge) only runs under an
    * LSP `Connection`. Running headless the bridge never fires; the
    * facade stands in for it on its own update path.
    *
    * Coexistence with an LSP head running on the same `DocumentBuilder` is
    * fine: the LSP head builds from the LSP-driven event and the facade from
    * its own RPC-driven event — both legitimate — and both go through
    * `HydraniumDocumentBuilder.scheduleUpdate`, which serialises them under
    * the workspace WRITE lock and lets the second share the first's build
    * where that build carries it. Langium alone does not coalesce concurrent
    * builds of one URI: two unserialised builds each run a full validation
    * pass and Langium appends the second set onto the first, duplicating every
    * diagnostic. Opt out via
    * {@link ModelServiceOptions.serializeBuilds} — see there for the
    * non-reentrancy hazard that is the reason the opt-out exists.
    *
    * An override calls the base before it awaits. Under an LSP connection the
    * store's change event has already asked the update handler to build a
    * session's write; an override whose await outlasts that build makes the
    * base's request start a build of its own, so the write is built and
    * delivered twice.
    *
    * Returns an empty `{ root, diagnostics }` envelope when the document
    * cannot be loaded; adopters that want to throw override this method
    * on their subclass.
    *
    * Consumers wanting "give me this doc at state X, building only if
    * needed" — use the per-state methods ({@link parsed} / {@link linked}
    * / {@link settled} / {@link indexed} / {@link validated}) instead.
    */
   async rebuild(uri: string, state?: DocumentState, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      return this.rebuildCanonical(this.uriPolicy.canonicalUri(uri), state, cancelToken);
   }

   /**
    * Internal build core operating on an already-{@link CanonicalUri canonical}
    * URI — the build counterpart to {@link waitForDocumentStateCanonical}.
    * Requests the build, then waits via the canonical wait core, so the
    * identity is resolved once at the public door and neither sink re-runs the
    * `realpath`. (`DocumentBuilder.update` still resolves each URI internally for
    * directory flattening — that is the build's own existence-aware resolution,
    * not a redundant identity canonicalisation.)
    */
   protected async rebuildCanonical(
      uri: CanonicalUri,
      state?: DocumentState,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>> {
      const documentUri = UriUtils.toUri(uri);
      // Runs under the workspace WRITE lock, through the builder's
      // `scheduleUpdate` like the LSP update handler's build, so the build the
      // store's change event already scheduled for this write carries this
      // request too rather than being cancelled by it.
      //
      // Unlocked, this build races the LSP bridge's build of the same URI: both
      // are legitimate (the bridge only exists under a `Connection`, so the
      // facade stands in for it headless), and nothing serialises the two, so
      // both reach `Validated`, and because each computes its missing
      // validation categories before the other has recorded its own, both run a
      // FULL pass and Langium appends the second onto the first (its append is
      // meant for category-partitioned passes). The user-visible result is every
      // diagnostic duplicated, plus double the validation work per write.
      //
      // Opt out via `ModelServiceOptions.serializeBuilds` — see there for
      // the non-reentrancy hazard that opt-out exists for.
      if (this.serializeBuilds.value) {
         // Fail loudly on the one shape the lock cannot survive. `WorkspaceLock`
         // is not reentrant: acquiring the write lock cancels the running holder,
         // so a caller already inside one — an integrity rule or build-phase pass
         // writing back through this facade — would cancel its own enclosing
         // build and then likely stall in the phase wait below. The check is
         // gated on `serializeBuilds` deliberately, because acquiring the lock IS
         // the hazard: with serialisation off the build takes no lock, which
         // makes the existing opt-out the guard's opt-out too.
         // Detection needs async-context propagation, so it is inert until a host
         // installs a tracker (`@hydranium/core/node` does) — see
         // `isInsideWriteLock`.
         if (isInsideWriteLock()) {
            throw new ReentrantWriteLockError(uri);
         }
         // The build runs on the lock's own token, which a later write cancels;
         // the caller's token governs only the phase wait below.
         await this.services.workspace.DocumentBuilder.scheduleUpdate([documentUri], []);
      } else {
         await this.services.workspace.DocumentBuilder.update([documentUri], [], cancelToken);
      }
      return this.waitForDocumentStateCanonical(uri, state ?? IntegrityService.SettledState, cancelToken);
   }

   /**
    * Per-state typed convenience methods. Each ensures the document at
    * `uri` reaches the named phase and returns the AST envelope with
    * the narrowest accurate diagnostics type for that phase. Smart
    * dispatch internally: warm path (URI already in the document
    * registry) just waits via {@link waitForDocumentState}; cold path
    * triggers a build via {@link rebuild}. Consumers do not need to
    * know which path was taken.
    *
    * Phase invariants encoded in the return type:
    * - `parsed` / `linked` / `settled` / `indexed` return
    *   `AstDocument<TAst, never>` — no diagnostics have been computed at
    *   those phases.
    * - `validated` returns `AstDocument<TAst, TDiagnostic>` — diagnostics
    *   are populated.
    *
    * **The `never` is enforced, not merely declared.** The wait underneath
    * resolves at or ABOVE the requested state, so a document something else
    * already carried past `Validated` would otherwise come back from
    * `settled()` carrying a full diagnostics array typed `never`; these four
    * strip it. An empty array here therefore means "this read does not report
    * diagnostics", never "this document is clean" — call {@link validated}
    * when the answer has to mean the second.
    *
    * `settled` is the integrity-overlay name for "all integrity rules
    * have fired"; it maps to {@link IntegrityService.SettledState} (which
    * equals `DocumentState.IndexedReferences`), but the dedicated method
    * exists so consumers track the semantic stability even if the landmark
    * ever moves.
    */
   async parsed(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.withoutDiagnostics(await this.ensureDocumentState(uri, DocumentState.Parsed, cancelToken));
   }

   async linked(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.withoutDiagnostics(await this.ensureDocumentState(uri, DocumentState.Linked, cancelToken));
   }

   async settled(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.withoutDiagnostics(await this.ensureDocumentState(uri, IntegrityService.SettledState, cancelToken));
   }

   async indexed(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.withoutDiagnostics(await this.ensureDocumentState(uri, DocumentState.IndexedReferences, cancelToken));
   }

   async validated(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      return this.ensureDocumentState(uri, DocumentState.Validated, cancelToken);
   }

   /**
    * Ensure the document at `uri` reaches `state` (or the integrity-settled
    * landmark {@link IntegrityService.SettledState} if omitted) and return its
    * AST envelope. Smart
    * dispatch: warm path (URI already in `LangiumDocuments`) just waits
    * via {@link waitForDocumentState}; cold path forces a build via
    * {@link rebuild}.
    *
    * Pairs with {@link rebuild} — same default phase, but `rebuild`
    * always builds while this skips the build for an already-loaded
    * document. Also pairs with {@link waitForDocumentState} — the verb
    * difference (`ensure` vs `waitFor`) signals the side-effect
    * difference. The per-state convenience methods (`parsed` / `linked`
    * / `settled` / `indexed` / `validated`) all delegate here with an
    * explicit phase.
    */
   async ensureDocumentState(uri: string, state?: DocumentState, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      return this.ensureDocumentStateCanonical(this.uriPolicy.canonicalUri(uri), state, cancelToken);
   }

   /**
    * Internal smart-dispatch core operating on an already-{@link CanonicalUri canonical}
    * URI. The `hasDocument` probe keys `LangiumDocuments` directly with the
    * canonical URI — no re-canonicalisation — which is the reason the parameter is
    * typed `CanonicalUri` rather than `string`. The warm path waits via the
    * canonical wait core ({@link waitForDocumentStateCanonical}); the cold path
    * dispatches through the public {@link rebuild} (which re-canonicalizes once,
    * idempotently) so an adopter `rebuild` override stays in the build path — the
    * one customization seam this chain deliberately preserves.
    */
   protected async ensureDocumentStateCanonical(
      uri: CanonicalUri,
      state?: DocumentState,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>> {
      const target = state ?? IntegrityService.SettledState;
      if (this.services.workspace.LangiumDocuments.hasDocument(UriUtils.toUri(uri))) {
         return this.waitForDocumentStateCanonical(uri, target, cancelToken);
      }
      return this.rebuild(uri, target, cancelToken);
   }

   /**
    * Wait for the document at `uri` to reach the integrity-settled landmark and
    * drain any in-flight write-path applyEdit sync chain (see {@link syncChains})
    * so every language client reflects the latest content before a save returns.
    * No-op tail for headless adopters — `syncChains` is empty without an LSP
    * client. Bounded by {@link SAVE_SETTLE_TIMEOUT_MS} so a hung build, or an
    * applyEdit reverse-RPC deadlock, can't freeze the caller; on timeout or a
    * failed wait it logs a warning and returns rather than throwing.
    *
    * Adopters with a save flow that must converge editor + disk before returning
    * (e.g. a dual form/code editor that would otherwise show a content-conflict
    * dialog on rapid save) call this after their `save`.
    */
   protected async settleSave(uri: string, cancelToken?: CancellationToken): Promise<void> {
      const canonical = this.uriPolicy.canonicalUri(uri);
      const key = UriUtils.toUri(canonical).toString();
      // One race over both waits, so the bound is one deadline for the pair;
      // a race per wait would let the save take twice the bound.
      const settled = (async (): Promise<void> => {
         await this.waitForDocumentStateCanonical(canonical, IntegrityService.SettledState, cancelToken);
         await this.syncChains.get(key);
      })();
      try {
         if ((await this.services.Clock.raceTimer(settled, SAVE_SETTLE_TIMEOUT_MS)) === TIMED_OUT) {
            this.tracer.withUri(key).warn(`Save settle exceeded ${SAVE_SETTLE_TIMEOUT_MS}ms — returning anyway`);
         }
      } catch (err: unknown) {
         // A failed wait, such as a cancelled token or a document the builder
         // does not hold, gets its own line so it is not blamed on the bound.
         const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
         this.tracer.withUri(key).warn(`Save settle failed before the timeout — returning anyway. ${detail}`);
      }
   }

   /**
    * True when the document at `uri` is currently open for at least one
    * client. Pure read; no side effects.
    */
   isOpen(uri: string): boolean {
      return this.services.workspace.AstDocumentManager.isOpen(uri);
   }

   /**
    * Snapshot of `uri` as it stands RIGHT NOW — the synchronous sibling of the
    * phase reads, which all wait. `undefined` when no document is registered.
    *
    * **This is what a writer wants, and {@link getDocument} is not.** The
    * envelope's `version` is copied by value at projection time, so it cannot
    * move afterwards; a version read off the live document at write time is
    * whatever the server is at *now*, which is the number an optimistic gate is
    * about to compare it against.
    *
    * Diagnostics only from a document that has reached `Validated`, and an
    * empty array otherwise. Unlike the phase reads this one names no phase, so
    * the state it finds is the only thing that can say whether the array
    * describes the content being handed back or whatever an earlier build left.
    * A caller that needs them unconditionally waits, via {@link validated}.
    */
   snapshot(uri: string): AstDocument<TAst, TDiagnostic> | undefined {
      const document = this.getDocument(uri);
      if (!document) {
         return undefined;
      }
      const envelope = AstDocument.from<TAst, TDiagnostic>(document);
      return document.state >= DocumentState.Validated ? envelope : this.withoutDiagnostics(envelope);
   }

   /**
    * The built {@link LangiumDocument} for `uri`, looked up by canonical identity —
    * the synchronous, phase-agnostic sibling of {@link ensureDocumentState} /
    * {@link waitForDocumentState} (which await a build state). The single
    * canonicalizing door for callers that need the live document without reaching
    * into `LangiumDocuments` directly: a symlinked / `..` / case-divergent URI
    * still resolves to the one document the build keys by its real path. Returns
    * `undefined` if no document is registered for `uri`.
    *
    * **Live, so do not take a based-on version off it.** `textDocument` is the
    * store's own object rather than a copy, so `.version` read here answers for
    * the moment of the READ, not the moment of the earlier content — pass it to
    * a write and the server compares its current version against itself, the
    * gate passes unconditionally, and a concurrent edit is overwritten with
    * nothing logged. Use {@link snapshot} for that, or a phase read.
    */
   getDocument(uri: string): LangiumDocument | undefined {
      return this.services.workspace.AstDocumentManager.getDocument(uri);
   }

   // ============================================================
   // Client sessions
   // ============================================================

   createSession<TOpenOptions extends OpenOptions = OpenOptions>(
      label?: string,
      clientId?: string
   ): ClientSession<TAst, TDiagnostic, TTransfer, TOpenOptions> {
      const sessionLabel = label ?? 'session';
      const id = clientId ?? `${sessionLabel}#${globalThis.crypto.randomUUID()}`;
      const textDocuments = this.services.workspace.TextDocuments;
      textDocuments.registerSession(id);
      this.sessionCloseListener ??= textDocuments.onDidCloseSession(event => {
         // Also reached when the store ends a session directly; disposing the
         // handle makes its later calls fail rather than write under an id
         // this service no longer treats as a session.
         this.sessions.get(event.clientId)?.dispose();
         this.sessions.delete(event.clientId);
      });
      let session: ClientSession<TAst, TDiagnostic, TTransfer, TOpenOptions>;
      try {
         // Unchecked: the session keeps whatever options its `open` is handed,
         // and the factory types it for every grammar, so the narrowed type
         // holds only for the caller that started it.
         session = this.services.model.ClientSessionFactory.create(id, sessionLabel) as ClientSession<
            TAst,
            TDiagnostic,
            TTransfer,
            TOpenOptions
         >;
      } catch (err: unknown) {
         textDocuments.closeSession(id);
         throw err;
      }
      this.sessions.set(id, session);
      return session;
   }

   getSession(clientId: string): ClientSession<TAst, TDiagnostic, TTransfer> | undefined {
      return this.sessions.get(clientId);
   }

   /**
    * Convert a structured-or-textual `model` payload to its textual form.
    *
    * Textual payloads (LSP / pre-serialised callers) pass through untouched.
    * Structured payloads run the per-language `UpdateRewriteService` chain
    * (transfer-model transforms; diff-aware rewrites see the previous AST root),
    * then serialise. The chain is the single transfer-model-transform seam — a
    * unary normalisation is just a rewrite that ignores `previous`, as
    * `NormalizeEmptyStringsContribution` does. The chain is empty by
    * default, so this is a no-op for adopters that register none.
    */
   async modelToText(uri: string, model: TTransfer | string, cancelToken?: CancellationToken): Promise<string> {
      if (typeof model === 'string') {
         return model;
      }
      const rewritten = await this.rewriteModel(uri, model, cancelToken);
      const target = UriUtils.toUri(uri);
      const trivia = this.services.ServiceRegistry?.getServices(target)?.trivia?.TriviaService;
      // Extracted BEFORE serializing, so it reads the document the write is
      // about to replace rather than whatever a concurrent build left behind.
      let document = this.services.workspace.LangiumDocuments.getDocument(target);
      if (trivia !== undefined && document === undefined) {
         const source = await this.textToTakeTriviaFrom(uri, target);
         if (source !== undefined) {
            document = this.services.workspace.LangiumDocumentFactory.fromString(source, target);
         }
      }
      const extracted = trivia !== undefined && document !== undefined ? trivia.extract(document) : undefined;
      const serialized = await this.serialize(uri, rewritten);
      return extracted === undefined ? serialized : trivia!.apply(serialized, extracted, target);
   }

   // ============================================================
   // LSP-client sync (mirror non-LSP-client changes back to Monaco)
   // ============================================================

   /**
    * Mirror a server-side change of `document` back to the LSP textual language
    * client, run per document as it reaches the post-integrity settled phase.
    * The single framework caller of
    * `HydraniumTextDocuments.applyEditToLanguageClient`.
    *
    * Only a document open in the language client is mirrored, through
    * {@link syncOpenDocument}, routed purely by **content**. A document open
    * only in another client needs nothing: a language client opening it joins
    * the existing entry and is refreshed from the store. A session writes only
    * what it has open, so no session edit of a closed document waits here for
    * the language client's next open.
    *
    * The decision is **re-derived from the current settled state every time** (it
    * is not a one-shot enrolment), which is what makes it self-healing: a doc
    * that still needs syncing on a later settle — a re-open refresh, a recovery
    * build after cancellation — is caught even though an earlier settle already
    * synced it.
    */
   protected syncToLanguageClient(document: LangiumDocument): void {
      // `document.textDocument.uri` is the server-identity (canonical) URI off the
      // build. Route by client registration (presence questions — both
      // predicates canonicalize internally, so a divergent open path still
      // resolves to the same record), but key the outbound sync by this
      // CANONICAL URI — the same key `settleSave` looks the chain up under —
      // so a save-settle can drain the in-flight applyEdit. The canonical→client-URI
      // translation (a symlinked path the client opened, or a dual-open fan-out)
      // happens at the `applyEditToLanguageClient` egress, where the text store maps
      // the canonical key to the recorded language-client URI(s); driving the chain
      // in client space here would key it under a URI `settleSave` never computes, so
      // the drain would miss for a divergent open path.
      if (this.services.workspace.TextDocuments.isOpenInLanguageClient(document.textDocument.uri)) {
         this.syncOpenDocument(document.textDocument.uri, document.textDocument.getText());
      }
   }

   /**
    * Mirror the settled text of a document open in the language client via a
    * coalesced `applyEditToLanguageClient`. `uri` is the document's CANONICAL identity
    * (the chain key); the egress (`applyEditToLanguageClient`) translates it to the
    * recorded language-client URI(s). Routed purely by **content**: the shadow
    * no-ops the RPC when Monaco already matches, so a Monaco echo (the client's
    * own edit coming back) and a cascade-affected doc whose serialized text is
    * unchanged both cost nothing — a string compare, no RPC. Author is
    * irrelevant here: the shadow suppresses the echo precisely, so no
    * author-based skip is needed.
    */
   protected syncOpenDocument(uri: string, text: string): void {
      this.queueSync(uri, text);
   }

   /**
    * Enqueue a sync to the language client. The pending slot per URI holds only
    * the latest text: if a newer settle fires while the current RPC is in
    * flight, the intermediate text is dropped and the chain picks up the latest
    * on its next iteration. Coalescing guarantees a single in-flight applyEdit
    * per URI so the shadow never drifts from Monaco.
    */
   protected queueSync(uri: string, text: string): void {
      this.pendingSync.set(uri, text);
      if (this.syncChains.has(uri)) {
         return;
      }
      // Start the drain a microtask late so `syncChains` is populated BEFORE the
      // first push goes out. Calling `drainSyncQueue` directly would run its
      // synchronous prologue — loop head plus the `applyEditToLanguageClient`
      // call — ahead of the `set` below, so a `queueSync` re-entered from within
      // that window would see no chain and start a SECOND one. Two concurrent
      // chains break the single-in-flight-per-URI guarantee this coalescing
      // exists to provide, and that guarantee is what keeps the shadow from
      // drifting: overlapping pushes diff against each other's optimistic
      // baseline and the later one can land stale text last.
      const chain = Promise.resolve()
         .then(() => this.drainSyncQueue(uri))
         .finally(() => {
            if (this.syncChains.get(uri) === chain) {
               this.syncChains.delete(uri);
            }
         });
      this.syncChains.set(uri, chain);
   }

   /**
    * The undo-stack label for a server-authored write, in the locale the server
    * was handed at init.
    *
    * One method rather than the literal at each `applyEdit`, because the two
    * call sites are the same edit — a push and its full-replace retry — and an
    * undo menu showing two different words for one operation would read as two
    * operations.
    */
   protected editLabel(): string {
      return this.services.MessageRenderer.renderMessage(MODEL_UPDATE_EDIT);
   }

   protected async drainSyncQueue(uri: string): Promise<void> {
      const uriLogger = this.tracer.withUri(uri);
      while (this.pendingSync.has(uri)) {
         const text = this.pendingSync.get(uri)!;
         this.pendingSync.delete(uri);
         try {
            let result = await this.services.workspace.TextDocuments.applyEditToLanguageClient(uri, text, { label: this.editLabel() });
            if (result?.applied === false && !this.pendingSync.has(uri)) {
               // The push is addressed at the client's LAST DECLARED VERSION, so a
               // rejection normally means the client's buffer moved while the
               // line-keyed diff was in flight — exactly the case where applying it
               // would splice the file. Dropping the push there would leave the
               // editor showing text the server has already superseded, with no
               // later settle guaranteed to correct it (a content-identical echo
               // mints no rebuild). The rejection invalidated the shadow, so the
               // retry is a full-range replace: position-independent, and therefore
               // correct against whatever the client now holds.
               //
               // Retried INLINE rather than re-enqueued, and exactly once. Inline
               // because a re-enqueue would have to out-order any settle that lands
               // in the meantime, which nothing here can guarantee; once because a
               // client that refuses every edit (a read-only file, a modal holding
               // the workspace) must cost one extra RPC rather than spin. The
               // `pendingSync` check skips the retry when a newer settle has already
               // queued — best-effort, since a settle arriving later simply pushes
               // after this and still wins.
               uriLogger.warn(`Language client rejected applyEdit at its declared version — re-pushing a full replace`);
               result = await this.services.workspace.TextDocuments.applyEditToLanguageClient(uri, text, { label: this.editLabel() });
               if (result?.applied === false) {
                  uriLogger.warn(`Language client rejected the full-replace retry too — client content is stale`);
               }
            }
         } catch (err: unknown) {
            // A disconnected client is not a failure of this edit: pushing text
            // to a peer that has gone is a no-op, and it happens on every
            // ordinary shutdown. Reporting it at `error` makes routine teardown
            // look like it needs investigating. A genuine applyEdit failure
            // (client refused, request malformed) still surfaces at `error`.
            if (isConnectionGoneError(err)) {
               uriLogger.debug(`applyEdit to ${LANGUAGE_CLIENT_ID} skipped: client disconnected`);
            } else {
               uriLogger.error(`applyEdit to ${LANGUAGE_CLIENT_ID} failed: ${err}`);
            }
         }
      }
   }

   // ============================================================
   // Subscription pass-throughs
   // ============================================================

   /**
    * Subscribe to AST-snapshot updates for `uri`. Fires after each
    * rebuild that reaches the target phase. Delegates to the
    * `HydraniumTextDocuments` — single listener registration shared with
    * any direct `HydraniumTextDocuments.onUpdate` subscriber, so the same
    * underlying `DocumentBuilder.onDocumentPhase` listener serves both
    * call paths. The event's reason, source and cause are
    * {@link AstDocumentManager.attributeUpdate}'s.
    */
   onModelUpdated(uri: string, listener: (event: AstDocumentUpdatedEvent<TAst, TDiagnostic>) => void): Disposable {
      return this.services.workspace.AstDocumentManager.onUpdate(uri, listener as never);
   }

   /**
    * Subscribe to save events for `uri`. Fires on every persist through
    * the multi-client text-document store — including saves originated
    * by other heads (LSP editor `Ctrl+S`, the data-server `save`, etc.)
    * so subscribers see one consistent stream regardless of who wrote
    * the file. Delegates to the manager — single listener registration
    * shared with any direct `HydraniumTextDocuments.onSave` subscriber.
    */
   onModelSaved(uri: string, listener: (event: AstDocumentSavedEvent<TAst, TDiagnostic>) => void): Disposable {
      return this.services.workspace.AstDocumentManager.onSave(uri, listener as never);
   }

   /**
    * Subscribe to the `(uri, clientId)` close event. Delegates to the
    * manager so the listener registry is shared with any direct
    * `HydraniumTextDocuments.onClientClosed` subscriber.
    */
   onClientClosed(uri: string, clientId: string, listener: () => void): Disposable {
      return this.services.workspace.AstDocumentManager.onClientClosed(uri, clientId, listener);
   }

   // ============================================================
   // Adopter hooks (override on subclass)
   // ============================================================

   /**
    * Serialise a transfer-model root via the language-specific
    * `Serializer` bound at `services.serializer.Serializer`,
    * resolved per-URI through `services.ServiceRegistry.getServices(uri)`
    * so multi-grammar workspaces route to the right serializer per file.
    * Adopters bind their own per-language; the framework default
    * `UnboundSerializer` throws if none is bound.
    *
    * Adopters whose serializer call shape differs (custom service
    * names, generator-driven YAML pretty printers, etc.) override this
    * method. Routes through `Serializer.serializeTransfer` because
    * a session's `update` / `save` always receive a
    * transfer-model shape (cross-references as plain strings) from
    * adopter callers — the AST-shape entry point is `serializeAst`.
    *
    * Returns {@link MaybePromise} so adopter `Serializer` overrides can be
    * async (remote schema lookup, external canonical-value resolution); the
    * single caller ({@link modelToText}) is already `async`,
    * so a naive `await` covers both branches without extra ceremony.
    */
   protected serialize(uri: string, root: TTransfer): MaybePromise<string> {
      const services = this.services.ServiceRegistry.getServices(UriUtils.toUri(uri));
      return services.serializer.Serializer.serializeTransfer(root);
   }

   // ============================================================
   // Protected plumbing (override sparingly)
   // ============================================================

   /**
    * The text a write into a document not yet built should take its trivia
    * from: the store's, which a write always has, since it writes only a
    * document its client has open.
    */
   protected async textToTakeTriviaFrom(uri: string, _target: URI): Promise<string | undefined> {
      return this.services.workspace.TextDocuments.get(uri)?.getText();
   }

   /**
    * Run the per-language transfer-model rewrite chain. Resolves the
    * `UpdateRewriteService` per-URI (like {@link serialize}) and threads
    * in the previous AST root — `document.parseResult.value`, or `undefined`
    * for a not-yet-built document — so diff-based rewrites can distinguish a
    * real user change from a stale echo.
    */
   protected async rewriteModel(uri: string, model: TTransfer, cancelToken?: CancellationToken): Promise<TTransfer> {
      // Optional-chain so incomplete test stubs (no ServiceRegistry / no
      // updateRewrite slot) degrade to the identity chain; production wiring
      // always provides the slot via `createServerLanguageModule`.
      const service = this.services.ServiceRegistry?.getServices(UriUtils.toUri(uri))?.updateRewrite?.UpdateRewriteService;
      if (!service) {
         return model;
      }
      const previous = this.services.workspace.AstDocumentManager.getDocument(uri)?.parseResult.value as TAst | undefined;
      return (await service.apply(model, previous, cancelToken)) as TTransfer;
   }

   /**
    * Build an {@link AstDocument} envelope from the current
    * {@link LangiumDocument} state via the shared {@link AstDocument.from}
    * projection. Returns an empty envelope (built via
    * {@link AstDocument.create}) when the document is absent from the
    * registry — adopters that prefer to throw override on their subclass.
    */
   protected toAstDocument(uri: URI): AstDocument<TAst, TDiagnostic> {
      const document = this.services.workspace.LangiumDocuments.getDocument(uri);
      return document
         ? AstDocument.from<TAst, TDiagnostic>(document)
         : AstDocument.create<TAst, TDiagnostic>(uri.toString(), 0, undefined as unknown as TAst, []);
   }

   /**
    * The same envelope with no diagnostics, for a read that names a phase below
    * `Validated`.
    *
    * Langium fills `LangiumDocument.diagnostics` from inside `validateDocument`
    * and from nowhere else, so below that phase the array holds whatever an
    * EARLIER build left — a verdict about text the document may no longer have.
    * The wait underneath resolves at or above the phase asked for, so a document
    * something else carried past `Validated` would otherwise hand a full array
    * back from `parsed()`.
    *
    * A copy rather than a clear: the envelope is freshly built here, but
    * {@link toAstDocument} is overridable and an adopter's version may return
    * one it also keeps.
    */
   protected withoutDiagnostics(document: AstDocument<TAst, TDiagnostic>): AstDocument<TAst, never> {
      return { ...document, diagnostics: [] };
   }
}
