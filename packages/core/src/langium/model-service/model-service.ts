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
   type CloseModelArgs,
   ConflictError,
   defineMessage,
   Logger,
   type MaybeObservableValue,
   type MaybePromise,
   ObservableValue,
   type TransferDiagnostic,
   type TransferElement,
   type OpenModelArgs,
   type Tracer,
   type TransferSaveArgs,
   type TransferUpdateArgs
} from '@hydranium/protocol';
import { type AstNode, DocumentState, type LangiumDocument, UriUtils, type URI } from '@hydranium/langium';
import { type DocumentUriPolicy } from '../workspace/document-uri-policy.js';
import { ReentrantWriteLockError, isInsideWriteLock } from '../workspace/write-lock-scope.js';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { AstDocument, type AstDocumentSavedEvent, type AstDocumentUpdatedEvent } from '../../documents/ast-document-manager.js';
import { isConnectionGoneError } from '../../util/connection-liveness.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { IntegrityService } from '../integrity/integrity-service.js';
import { labelPhaseListener } from '../document-builder/labeled-phase-listener.js';
import { LANGUAGE_CLIENT_ID } from '../../documents/client-ids.js';
import { type ServerSharedServices } from '../module.js';

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

/** Max time {@link ModelService.settleSave} waits for the build to settle and the sync chain to drain. */
const SAVE_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Marks the {@link SAVE_SETTLE_TIMEOUT_MS} branch of
 * {@link ModelService.settleSave}'s race so it stays distinguishable from a
 * genuine rejection (a cancelled token, an `applyEdit` reverse-RPC error, a
 * build throw). With a plain `Error` the only log line an adopter has blames
 * the timeout for every one of them, which points debugging at the wrong layer.
 */
class SaveSettleTimeoutError extends Error {}

/**
 * Constructor options for {@link ModelService}. All fields are optional,
 * and the defaults are the behaviour described on each one.
 */
export interface ModelServiceOptions extends LogNameOptions {
   /**
    * When set, {@link ModelService.update} logs a `warn` line if its
    * end-to-end wait (serialise + content-change apply + rebuild +
    * settled-phase wait) exceeds this many milliseconds. Default
    * `undefined` (no warn line ever emitted; the underlying
    * `Logger.time` debug timing log is unchanged either way).
    *
    * Pure observability — does NOT abort the update, does NOT change
    * resolution semantics. Adopters wanting a hard timeout that throws
    * instead override {@link ModelService.update} on their subclass and
    * race the parent call against their own deadline.
    *
    * Recommended starting threshold: 2-5 seconds for interactive paths
    * (form save, diagram edit). Workspaces with very large documents
    * or slow validation may legitimately exceed 5s on the cold path —
    * tune per workspace.
    *
    * Accepts a {@link MaybeObservableValue} so the threshold can be a
    * fixed constant or bound to a user setting via `Settings.number`
    * and retuned live. Leaving it unset disables the warn line entirely
    * (and skips the per-update stopwatch).
    */
   readonly slowUpdateWarnMs?: MaybeObservableValue<number>;
   /**
    * Serialise the facade's own build under the workspace WRITE lock, the way
    * Langium's `DefaultDocumentUpdateHandler` dispatches its build. Default
    * `true`.
    *
    * **Why it defaults on.** Unlocked, the facade's build races the LSP bridge's
    * build of the same URI — both are legitimate (the bridge exists only under a
    * `Connection`, so the facade stands in for it headless), but nothing
    * serialises them, so both run a full validation pass and Langium appends the
    * second onto the first. Every diagnostic is then duplicated, and the
    * duplication compounds per rebuild. Serialised, Langium elides the second
    * build entirely, so the redundant work goes too.
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
    * reaches `update` / `save` / `rebuild` while already holding the write lock —
    * an integrity rule or build-phase pass that writes through this facade —
    * deadlocks: acquiring the lock cancels the running holder, and the new
    * acquisition then waits for that holder to release while the holder waits
    * for this call. On `true` that shape is DETECTED and rejected with
    * {@link ReentrantWriteLockError} rather than hanging, wherever a host
    * installs a write-lock scope tracker (`@hydranium/core/node` does at entry
    * load; see {@link isInsideWriteLock}). Setting `false` is the escape hatch
    * for an adopter whose reentrant shape is unavoidable — nothing acquires the
    * lock then, so there is nothing to be reentrant about; prefer it over
    * unserialised builds only in that case.
    *
    * Accepts a {@link MaybeObservableValue} so it can be bound to a setting and
    * flipped without a restart.
    */
   readonly serializeBuilds?: MaybeObservableValue<boolean>;
}

/**
 * In-process facade over the framework's document plumbing
 * (`HydraniumTextDocuments`, `LangiumDocuments`,
 * `DocumentBuilder`, `WritableFileSystemProvider`). Owns the
 * `open / request / update / save / ready` lifecycle that protocol heads
 * (LSP, data-server, GLSP) delegate to so coordinating those primitives
 * doesn't have to be re-implemented per-head.
 *
 * "Model" here means the parsed AST — distinct from the wire-shape
 * `TransferDocument` in `@hydranium/protocol`.
 *
 * **Why a facade**
 *
 * Multiple in-process consumers want the same workspace-level
 * operations:
 * - The data-server head turns these into typed RPC methods.
 * - The GLSP head uses the same lifecycle for diagram-driven edits;
 *   GModel operation handlers route through `update` for AST mutation,
 *   `waitForDocumentState` for indexed-phase waits before reads, etc.
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
 * The default `update` and `save` flows use Langium's per-URI
 * `DocumentBuilder.waitUntil` to wait for the integrity-settled landmark
 * ({@link IntegrityService.SettledState}), then read the post-build state. Concurrent
 * in-process callers on the same URI all see the latest post-build
 * snapshot — none deadlock waiting for a specific version's settled
 * event. Adopters wanting strict version-matched semantics (resolve
 * with vN's snapshot specifically, log "vN superseded by vM at vN+1")
 * override {@link update} to attach a phase-listener with explicit
 * version checks; the framework default doesn't need it for safety.
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
 * **Generic parameters.**
 * - `TAst` — the AST root type each consumer expects on the returned
 *   {@link AstDocument}. Constrained to {@link AstNode}.
 * - `TDiagnostic` — wire diagnostic shape used by the injected
 *   `TransferEncoder`. Defaults to {@link TransferDiagnostic}.
 * - `TTransfer` — transfer-model root accepted by `update` / `save`
 *   args. Constrained to {@link TransferElement}. Defaults to the
 *   structural base.
 */
export class ModelService<
   TAst extends AstNode,
   TDiagnostic = TransferDiagnostic,
   /**
    * Structured payload accepted by `update` / `save`. Constrained to
    * {@link TransferElement} — the minimal `{ readonly $type: string }`
    * shape. Both transfer-model overlay roots (which extend
    * `TransferElement` explicitly) and AST root types (which have
    * `$type: string` as a required `AstNode` field) satisfy the
    * constraint, so in-process callers (e.g. GLSP state or an
    * integrity service) that pass AST roots remain compatible.
    */
   TTransfer extends TransferElement = TransferElement
> {
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
   /**
    * Live slow-update-warn threshold cell, or `undefined` when the option
    * was not supplied (warn line + stopwatch disabled). Reads `.value` per
    * update so a setting-bound threshold retunes without reconstruction.
    */
   protected readonly slowUpdateWarn?: ObservableValue<number>;
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
      this.slowUpdateWarn = options.slowUpdateWarnMs !== undefined ? ObservableValue.from(options.slowUpdateWarnMs) : undefined;
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
   async waitForDocumentSettled(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      return this.waitForDocumentStateCanonical(this.uriPolicy.canonicalUri(uri), IntegrityService.SettledState, cancelToken);
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
    * Always triggers `DocumentBuilder.update([uri], [])` regardless of
    * whether the document is already in the registry — call this when
    * you want to re-process from scratch.
    *
    * The facade is responsible for firing `DocumentBuilder.update`
    * directly because Langium's `DefaultDocumentUpdateHandler.didChangeContent`
    * (the standard text-document → builder bridge) only runs under an
    * LSP `Connection`. Running headless the bridge never fires; the
    * facade stands in for it on its own update path.
    *
    * Coexistence with an LSP head running on the same `DocumentBuilder` is
    * fine, but not because the builder merges the two: Langium does NOT
    * coalesce concurrent builds of the same URI. The LSP head fires `update`
    * from the LSP-driven event and the facade fires it from its own RPC-driven
    * event — both legitimate — so this method takes the workspace WRITE lock,
    * the same one Langium's own text-change bridge builds under, to serialise
    * them. Two unserialised builds of one URI each run a full validation pass
    * and Langium appends the second set onto the first, duplicating every
    * diagnostic. Opt out via
    * {@link ModelServiceOptions.serializeBuilds} — see there for the
    * non-reentrancy hazard that is the reason the opt-out exists.
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
    * URI — the build counterpart to {@link waitForDocumentStateCanonical}. Drives
    * `DocumentBuilder.update` then waits via the canonical wait core, so the
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
      // Runs under the workspace WRITE lock, matching Langium's own
      // `DefaultDocumentUpdateHandler`, which dispatches its build as
      // `workspaceLock.write(token => documentBuilder.update(...))`.
      //
      // Unlocked, this build races the LSP bridge's build of the same URI: both
      // are legitimate (the bridge only exists under a `Connection`, so the
      // facade stands in for it headless), and the coexistence note above relied
      // on Langium coalescing them by URI. It does not — nothing serialises the
      // two, so both reach `Validated`, and because each computes its missing
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
         // the hazard: with serialisation off there is nothing to be reentrant
         // about, which makes the existing opt-out the guard's opt-out too.
         // Detection needs async-context propagation, so it is inert until a host
         // installs a tracker (`@hydranium/core/node` does) — see
         // `isInsideWriteLock`.
         if (isInsideWriteLock()) {
            throw new ReentrantWriteLockError(uri);
         }
         // The lock's OWN token, not the caller's: a later `write` cancels the
         // running one through that token, so substituting the caller's would
         // leave this build deaf to the lock's cancellation protocol. A caller
         // token still governs the phase wait below.
         await this.services.workspace.WorkspaceLock.write(lockToken =>
            this.services.workspace.DocumentBuilder.update([documentUri], [], lockToken)
         );
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
    * **The `never` is a claim about the PHASE, not a guarantee about the
    * instance, and the gap is reachable rather than theoretical.** The wait
    * underneath resolves at or ABOVE the requested state, so a document
    * something else already carried past `Validated` comes back from
    * `settled()` with a populated diagnostics array typed `never`. Nothing
    * strips it — the envelope copies the live document's array verbatim — and
    * any host that validates its workspace before a consumer asks produces
    * exactly that. So read an empty array as "none were computed, or there are
    * none", never as "this document is clean", and call {@link validated} when
    * the answer has to mean the second.
    *
    * `settled` is the integrity-overlay name for "all integrity rules
    * have fired"; it maps to {@link IntegrityService.SettledState} (which
    * equals `DocumentState.IndexedReferences`), but the dedicated method
    * exists so consumers track the semantic stability even if the landmark
    * ever moves.
    */
   async parsed(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.ensureDocumentState(uri, DocumentState.Parsed, cancelToken) as Promise<AstDocument<TAst, never>>;
   }

   async linked(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.ensureDocumentState(uri, DocumentState.Linked, cancelToken) as Promise<AstDocument<TAst, never>>;
   }

   async settled(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.ensureDocumentState(uri, IntegrityService.SettledState, cancelToken) as Promise<AstDocument<TAst, never>>;
   }

   async indexed(uri: string, cancelToken?: CancellationToken): Promise<AstDocument<TAst, never>> {
      return this.ensureDocumentState(uri, DocumentState.IndexedReferences, cancelToken) as Promise<AstDocument<TAst, never>>;
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
    * Apply an update for `uri`. The structured-or-textual `model` payload
    * is serialised (via {@link serialize} after {@link rewriteModel} when
    * structured), pushed into the multi-client text-document store with
    * a fresh version, drives a build to the target phase, and returns
    * the post-build AST snapshot.
    *
    * **Read-latest supersession**: concurrent callers on the same URI
    * all see the same post-build state once `waitUntil` resolves; none
    * deadlock waiting for a specific version's settled event. The
    * framework emits a post-resolution `debug` log line distinguishing
    * "vN ready" from "vN ready at vM (superseded)" so callers can
    * observe when their write was overtaken by a newer one before
    * settling — purely observability, doesn't change resolution
    * semantics. Adopters wanting version-matched resolution (resolve
    * with vN's specific settled snapshot, intermediate-phase
    * observability, slow-warn / hard-timeout behaviour) override this
    * method.
    */
   async update(args: TransferUpdateArgs<TTransfer>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      const stopwatch = this.slowUpdateWarn !== undefined ? this.services.Clock.stopwatch() : undefined;
      // Per-stage self-time breakdown of the update/reconcile chain (serialise →
      // open → apply → rebuild), opt-in at debug — the default path skips the
      // session and `run` calls the stage directly. `update` is a per-operation
      // method (one user save / diagram edit), not a per-node hot loop, so the
      // stage closures `run` allocates on the non-debug path are negligible.
      // Canonicalize the write URI once at the door and thread the resulting
      // CanonicalUri through the chain. The text store keys documents by their
      // canonical identity, so any spelling of a file — a canonical
      // (server-identity) URI from a GLSP cross-document save derived from
      // `findDocument(node).uri`, or the symlink path an editor opened — collapses
      // to the one registration; there is no second registration to fork. The
      // build step reuses the canonical wait core (`rebuildCanonical`) so the
      // identity is not re-resolved downstream.
      const uri = this.uriPolicy.canonicalUri(args.uri);
      const session = Logger.isLevelEnabled('debug') ? this.tracer.profile(`model-update ${uri}`) : undefined;
      const run = async <T>(stage: string, fn: () => MaybePromise<T>): Promise<T> => (session ? session.scope(stage, fn) : fn());
      // Open WITH the new text so a cold URI (no open editor, no file on disk) is
      // created from the payload rather than read from the filesystem — `update`
      // is an upsert. For an already-open document `open` refreshes content (the
      // text is ignored on that branch), so existing-document behaviour is
      // unchanged. `version` is intentionally NOT forwarded to `open`: a cold
      // create stays at its initial version, so a based-on-`version` update of a
      // not-yet-existing document still trips the conflict gate below.
      const text = await run('serialize', () => this.modelToText(uri, args.model, cancelToken));
      await run('open', () => this.open({ uri, clientId: args.clientId, text }));
      if (args.baseVersion !== undefined) {
         const current = this.services.workspace.TextDocuments.version(uri);
         if (current !== args.baseVersion) {
            // Distinct from the post-build "superseded" debug line below: this is a
            // based-on-stale rejection (the write never applies), not two writes racing.
            this.tracer.debug(`Conflict on ${uri}: based-on v${args.baseVersion} stale, server at v${current}`);
            throw new ConflictError(uri, args.baseVersion, current);
         }
      }
      const appliedVersion = await run('apply', () => this.services.workspace.AstDocumentManager.update(uri, text, args.clientId));
      // Dispatch through the public `rebuild` (which re-canonicalizes the already-
      // canonical `uri` once, idempotently) rather than `rebuildCanonical`, so an
      // adopter `rebuild` override stays in the update path. The redundant call is
      // a single kernel-cached `realpath`; correctness of the override contract
      // wins over shaving it.
      const doc = await run('rebuild', () => this.rebuild(uri, undefined, cancelToken));
      const finalVersion = this.services.workspace.TextDocuments.version(uri);
      if (finalVersion > appliedVersion) {
         this.tracer.debug(`Update to v${appliedVersion} ready at v${finalVersion} (superseded)`);
      } else {
         this.tracer.debug(`Update to v${appliedVersion} ready`);
      }
      if (this.slowUpdateWarn !== undefined && stopwatch) {
         const elapsed = Math.round(stopwatch.elapsedMs);
         const threshold = this.slowUpdateWarn.value;
         if (elapsed >= threshold) {
            this.tracer.withUri(uri).warn(`Slow update: ${elapsed}ms ≥ ${threshold}ms (v${appliedVersion}, client=${args.clientId})`);
         }
      }
      // One line per stage (serialise / open / apply / rebuild) + unaccounted — only when profiling.
      session?.report('debug');
      return doc;
   }

   /**
    * Persist `uri` to disk. Same content-change + settled-phase flow as
    * {@link update}, then writes via the
    * `WritableFileSystemProvider` and notifies the multi-client
    * text-document store of the save (so any open LSP-side editor sees
    * the `onDidSave` event regardless of who originated the persist).
    *
    * Returns the post-save AST snapshot.
    */
   async save(args: TransferSaveArgs<TTransfer>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      // Dispatch through `update` (not its internals) so an adopter `update`
      // override — version-matched resolution, etc. — applies to saves too.
      const doc = await this.update(args, cancelToken);
      // Persist under the same canonical identity `update` operated on. Writing
      // the canonical (real) path follows any symlink to the same file, and the
      // `onDidSave` keys the one canonical registration.
      const uri = this.uriPolicy.canonicalUri(args.uri);
      await this.services.workspace.AstDocumentManager.save(uri, args.clientId);
      return doc;
   }

   /**
    * Wait for the document at `uri` to reach the integrity-settled landmark and
    * drain any in-flight write-path applyEdit sync chain (see {@link syncChains})
    * so every language client reflects the latest content before a save returns.
    * No-op tail for headless adopters — `syncChains` is empty without an LSP
    * client. Bounded by {@link SAVE_SETTLE_TIMEOUT_MS} so a hung build, or an
    * applyEdit reverse-RPC deadlock, can't freeze the caller; on timeout it logs
    * a warning and returns rather than throwing.
    *
    * Adopters with a save flow that must converge editor + disk before returning
    * (e.g. a dual form/code editor that would otherwise show a content-conflict
    * dialog on rapid save) call this after their `save`.
    */
   protected async settleSave(uri: string, cancelToken?: CancellationToken): Promise<void> {
      const canonical = this.uriPolicy.canonicalUri(uri);
      const key = UriUtils.toUri(canonical).toString();
      const timeout = new Promise<void>((_, reject) =>
         setTimeout(() => reject(new SaveSettleTimeoutError('settle timeout')), SAVE_SETTLE_TIMEOUT_MS)
      );
      try {
         await Promise.race([this.waitForDocumentStateCanonical(canonical, IntegrityService.SettledState, cancelToken), timeout]);
         const pending = this.syncChains.get(key);
         if (pending) {
            await Promise.race([pending, timeout]);
         }
      } catch (err: unknown) {
         if (err instanceof SaveSettleTimeoutError) {
            this.tracer.withUri(key).warn(`Save settle exceeded ${SAVE_SETTLE_TIMEOUT_MS}ms — returning anyway`);
         } else {
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
            this.tracer.withUri(key).warn(`Save settle failed before the timeout — returning anyway. ${detail}`);
         }
      }
   }

   /**
    * Open the document at `args.uri` on behalf of `args.clientId`.
    * Multi-client: each (uri, clientId) pair is tracked as one
    * registration; the underlying document stays open until the last
    * client closes it. If `args.text` is omitted the document content
    * is read from the `FileSystemProvider`.
    *
    * Returns a {@link Disposable} that closes the registration when
    * disposed — useful for `using` blocks and shutdown cleanup.
    *
    * Delegates to the framework-bound
    * `services.workspace.AstDocumentManager`. Adopter subclasses with
    * extra open-time behaviour (logging, sync-chain bootstrapping)
    * override on their `ModelService` subclass and call `super.open`.
    *
    * The open path does not thread cancellation: `AstDocumentManager.open`
    * and the filesystem read behind it take no token, so a cancelled caller
    * still completes the open.
    */
   async open(args: OpenModelArgs): Promise<Disposable> {
      return this.services.workspace.AstDocumentManager.open(args);
   }

   /**
    * Close the document at `args.uri` for `args.clientId`. Counterpart
    * to {@link open}; the underlying document stays open until every
    * registered client has closed.
    */
   async close(args: CloseModelArgs): Promise<void> {
      return this.services.workspace.AstDocumentManager.close(args);
   }

   /**
    * True when the document at `uri` is currently open for at least one
    * client. Pure read; no side effects.
    */
   isOpen(uri: string): boolean {
      return this.services.workspace.AstDocumentManager.isOpen(uri);
   }

   /**
    * The built {@link LangiumDocument} for `uri`, looked up by canonical identity —
    * the synchronous, phase-agnostic sibling of {@link ensureDocumentState} /
    * {@link waitForDocumentState} (which await a build state). The single
    * canonicalizing door for callers that need the live document without reaching
    * into `LangiumDocuments` directly: a symlinked / `..` / case-divergent URI
    * still resolves to the one document the build keys by its real path. Returns
    * `undefined` if no document is registered for `uri`.
    */
   getDocument(uri: string): LangiumDocument | undefined {
      return this.services.workspace.AstDocumentManager.getDocument(uri);
   }

   // ============================================================
   // LSP-client sync (mirror non-LSP-client changes back to Monaco)
   // ============================================================

   /**
    * Mirror a server-side change of `document` back to the LSP textual language
    * client, run per document as it reaches the post-integrity settled phase.
    * The single framework caller of
    * `HydraniumTextDocuments.applyEditToLanguageClient` and
    * `HydraniumTextDocuments.stagePendingContent`.
    *
    * Routes to one of two mechanisms by language-client registration, because
    * an open and a closed document answer different questions:
    *
    * - **Open in the language client** → {@link syncOpenDocument}: mirror the
    *   settled text via a coalesced `applyEditToLanguageClient`, routed purely by
    *   **content**.
    * - **Closed in the language client** → {@link stageClosedDocument}: stage the
    *   text for the eventual first `didOpen`, gated by **provenance**
    *   ({@link isNonLanguageClientEdit}).
    *
    * The decision is **re-derived from the current settled state every time** (it
    * is not a one-shot enrolment), which is what makes it self-healing: a doc
    * that still needs syncing on a later settle — a re-open refresh, a recovery
    * build after cancellation — is caught even though an earlier settle already
    * synced it.
    */
   protected syncToLanguageClient(document: LangiumDocument): void {
      // `document.textDocument.uri` is the server-identity (canonical) URI off the
      // build. Route by language-client registration (a presence question —
      // `isOpenInLanguageClient` canonicalizes internally, so a divergent open path
      // still resolves to the same record), but key the outbound sync by this
      // CANONICAL URI — the same key `settleSave` looks the chain up under —
      // so a save-settle can drain the in-flight applyEdit. The canonical→client-URI
      // translation (a symlinked path the client opened, or a dual-open fan-out)
      // happens at the `applyEditToLanguageClient` egress, where the text store maps
      // the canonical key to the recorded language-client URI(s); driving the chain
      // in client space here would key it under a URI `settleSave` never computes, so
      // the drain would miss for a divergent open path.
      if (this.services.workspace.TextDocuments.isOpenInLanguageClient(document.textDocument.uri)) {
         this.syncOpenDocument(document.textDocument.uri, document.textDocument.getText());
      } else {
         this.stageClosedDocument(document);
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
    * Stage the settled text of a document closed in the language client so the
    * eventual first `didOpen` sees this in-memory text instead of stale disk —
    * but only for a {@link isNonLanguageClientEdit genuine non-language-client edit}.
    * A document rebuilt by an internal build is skipped, leaving disk authoritative
    * on the next open.
    */
   protected stageClosedDocument(document: LangiumDocument): void {
      if (this.isNonLanguageClientEdit(document)) {
         this.services.workspace.TextDocuments.stagePendingContent(document.textDocument.uri, document.textDocument.getText());
      }
   }

   /**
    * Whether `document`'s settled state is a genuine edit by a client *other than
    * the language client* — a write a form / GLSP / integrity client actually made.
    * Excludes two non-edits: the **language client** itself (the LSP/Monaco text
    * client — it already holds its own edits, and the staging here exists to feed
    * it) and an **internal build** (workspace startup, a cascade relink, a
    * `didClose`-reload). This is the gate for {@link stageClosedDocument}: staging
    * an internal build would
    * (a) pre-stage every file on boot and (b) re-stage discarded content after
    * close (e.g. a disposing GLSP session's debounced submit firing after close),
    * which then shadows clean disk on the next open.
    *
    * The signal is "a known client other than the language client authored this
    * version **and** the URI was in the last build's changed set
    * (`isDirectChange`)". A framework-internal rebuild reports no author
    * (`getAuthor` → `undefined`), so it fails `hasKnownAuthor` without comparing
    * against a sentinel. This is NOT redundant with content/registration — it
    * distinguishes "client edited" from "framework rebuilt", which neither the
    * shadow nor `isDirectChange` alone can.
    */
   protected isNonLanguageClientEdit(document: LangiumDocument): boolean {
      const documents = this.services.workspace.AstDocumentManager;
      const author = documents.getAuthor(document);
      const hasKnownAuthor = !!author && author !== LANGUAGE_CLIENT_ID;
      return hasKnownAuthor && documents.isDirectChange(document.textDocument.uri);
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
    * call paths. `sourceClientId` is resolved from the multi-client
    * author history; reason discrimination follows the manager's own
    * `lastUpdate` snapshot (see `AstDocumentManager.onUpdate`).
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
    * `ModelService.update` / `ModelService.save` always receive a
    * transfer-model shape (cross-references as plain strings) from
    * adopter callers — the AST-shape entry point is `serializeAst`.
    *
    * Returns {@link MaybePromise} so adopter `Serializer` overrides can be
    * async (remote schema lookup, external canonical-value resolution); the
    * single caller ({@link modelToText} → {@link update}) is already `async`,
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
   protected async modelToText(uri: string, model: TTransfer | string, cancelToken?: CancellationToken): Promise<string> {
      if (typeof model === 'string') {
         return model;
      }
      const rewritten = await this.rewriteModel(uri, model, cancelToken);
      return this.serialize(uri, rewritten);
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
}
