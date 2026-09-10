/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MarkersReason, SetMarkersAction } from '@eclipse-glsp/protocol';
import {
   type Action,
   ActionDispatcher,
   type ClientSession,
   type ClientSessionListener,
   ClientSessionManager,
   CommandStack,
   type DefaultCommandStack,
   type Disposable,
   EditMode,
   GLSPServerError,
   Logger as GlspLogger,
   type MaybePromise,
   ModelState,
   ModelSubmissionHandler,
   ModelValidator,
   type RequestModelAction,
   SOURCE_URI_ARG,
   type SaveModelAction,
   SetEditModeAction,
   type SourceModelStorage,
   TEMPORARY_CLIENT_ID
} from '@eclipse-glsp/server';
import { Debouncer, defineMessage, DisposableCollection } from '@hydranium/protocol';
import { inject, injectable, optional, postConstruct } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { AstDocument, type AstDocumentSavedEvent, type AstDocumentUpdatedEvent, type ServerSharedServices } from '@hydranium/core';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { type HydraniumGlspSubmissionHandler } from '../submission/hydranium-glsp-submission-handler.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { DEFAULT_SAVE_CONFLICT_POLICY, SaveConflictPolicy } from './save-conflict-policy.js';

/**
 * A save action arrived with nowhere to write to. A save action carries no
 * request id, so it falls through to the error handler and `message` becomes
 * the toast text.
 *
 * Rendered at the raise site rather than by a carrier method, because GLSP's
 * action protocol has no slot for an identity anywhere — every member of its
 * message, status and reject actions is prose or an enum, and
 * `MessageAction.details` is not a substitute since it is prose populated from
 * `cause?.toString?.()`, and a Theia host shows it to a user on demand. So the
 * throw is the last place that still knows which message this is.
 */
export const SAVE_TARGET_UNKNOWN = defineMessage(
   'hydranium/glsp-server/save-target-unknown',
   'Could not determine where to save this model'
);

/**
 * A model request arrived without the source URI it is required to carry.
 * Rendered at the raise site, like its save-path sibling and for the same
 * reason.
 */
export const SOURCE_URI_MISSING = defineMessage(
   'hydranium/glsp-server/source-uri-missing',
   'Could not open this model: the request did not say which document to load'
);

/** Window (ms) over which back-to-back external rebuilds collapse into one resubmit. */
const EXTERNAL_SUBMIT_DEBOUNCE_MS = 250;

/**
 * A leading URI scheme — two or more characters before the colon.
 *
 * RFC 3986 permits a single-character scheme, but requiring two is what keeps a
 * Windows drive letter from reading as one. No scheme in play here is shorter
 * than two characters, so the heuristic costs nothing and the alternative
 * mis-parses every Windows path.
 */
const URI_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]+:/;

/**
 * True when an (untyped) LSP diagnostic marks an unrecoverable syntax problem.
 * Framework-level diagnostics are `unknown` (the shared `ModelService` is typed
 * `<AstNode, unknown>`), so the shape is narrowed defensively before reading the
 * Langium `data.code`.
 */
function isStructuralDiagnostic(diagnostic: unknown): boolean {
   if (typeof diagnostic !== 'object' || diagnostic === null) {
      return false;
   }
   const candidate = diagnostic as { severity?: number; data?: { code?: unknown } };
   const code = candidate.data?.code;
   return candidate.severity === DiagnosticSeverity.Error && (code === 'lexing-error' || code === 'parsing-error');
}

/**
 * GLSP source-model storage base shared by all hydranium adopters.
 * Provides the DI signature, the {@link ClientSessionListener} +
 * {@link Disposable} lifecycle plumbing (including the
 * {@link DisposableCollection} drain on session disposal), the
 * {@link RequestModelAction} / {@link SaveModelAction} URI-extraction
 * helpers, and the live load/rebuild/resubmit flow with a settled-root
 * invariant.
 *
 * **The settled-root invariant.** Every {@link AbstractHydraniumGlspState.setSourceRoot}
 * the framework performs captures a root that has reached
 * `IntegrityService.SettledState` (post-`Linked`, references indexed, on-build
 * integrity rules applied). The GModel factory therefore always walks a fully
 * linked + reprojected AST. The flow never captures off a transient mid-rebuild
 * snapshot — notably it re-`settled()`s in the resubmit path rather than trusting
 * the `onModelUpdated` event's document, which can arrive while a re-entered
 * document is still being rebuilt.
 *
 * Adopters with richer needs override the seams ({@link isStructurallyBroken},
 * {@link onParseErrorChanged}, {@link onSourceModelSettled}) rather than the
 * whole flow, and select a {@link SaveConflictPolicy} via the bound option to
 * tune how {@link saveSourceModel} reacts to a concurrent edit.
 *
 * **Default `saveSourceModel` flow.** Delegates to `ModelService.save`, which
 * serialises through the language-specific `Serializer` bound at
 * `services.serializer.Serializer` (resolved per-URI via `ServiceRegistry`),
 * updates the multi-client text-document store, drives a rebuild, and writes the
 * result via the `WritableFileSystemProvider`. The bound
 * {@link SaveConflictPolicy} (default {@link DEFAULT_SAVE_CONFLICT_POLICY},
 * `overwrite`) decides the based-on-version guard, await-vs-fire-and-forget, and
 * failure handling.
 *
 * **tempId filter.** GLSP's `DefaultGlobalActionProvider` spins up a
 * throwaway per-diagram-type container with upstream's {@link TEMPORARY_CLIENT_ID}
 * placeholder purely to enumerate action kinds, then calls `unbindAll()`.
 * The {@link postConstruct} hook skips registration for that placeholder so
 * it doesn't linger in {@link ClientSessionManager}.
 *
 * **Lifecycle ordering.** `init` runs after DI resolution and parks the
 * secondary-write-set watch, which outlives any single load.
 * {@link sessionDisposed} calls {@link dispose}, which drains
 * {@link toDispose} idempotently. Every transient subscription created in
 * {@link doLoadSourceModel} is parked on {@link toDispose} so the drain catches
 * them on client-detach.
 */
@injectable()
export class HydraniumGlspStorage<TRoot extends AstNode, TSourceModel = string>
   implements SourceModelStorage, ClientSessionListener, Disposable
{
   @inject(GlspLogger) protected readonly logger!: GlspLogger;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;
   @inject(ModelState) protected readonly state!: AbstractHydraniumGlspState<TRoot, TSourceModel>;
   @inject(ClientSessionManager) protected readonly sessionManager!: ClientSessionManager;
   @inject(ActionDispatcher) protected readonly actionDispatcher!: ActionDispatcher;
   @inject(ModelSubmissionHandler) protected readonly submissionHandler!: HydraniumGlspSubmissionHandler<TRoot, TSourceModel>;
   @inject(CommandStack) protected readonly commandStack!: DefaultCommandStack;

   /**
    * Optional {@link ModelValidator} whose markers are pushed to the client by
    * {@link refreshDiagnosticMarkers}. Bound per diagram via
    * `DiagramModule.bindModelValidator()`; absent (no push) when the head binds
    * no validator. The framework default is `HydraniumGlspModelValidator`
    * (LSP diagnostics → markers).
    */
   @inject(ModelValidator) @optional() protected readonly modelValidator?: ModelValidator;

   /**
    * Selected {@link SaveConflictPolicy} for {@link saveSourceModel}. Bind the
    * {@link SaveConflictPolicy} token in a `DiagramModule` to choose a policy;
    * left unbound it resolves to {@link DEFAULT_SAVE_CONFLICT_POLICY}
    * (`overwrite`, last-write-wins). Read via {@link saveConflictPolicy} so the
    * fallback is applied even when inversify injects `undefined` for an unbound
    * `@optional()` member.
    */
   @inject(SaveConflictPolicy) @optional() protected readonly boundSaveConflictPolicy?: SaveConflictPolicy;

   /** Disposables created during {@link doLoadSourceModel}; drained on session disposal. */
   protected toDispose = new DisposableCollection();

   /**
    * Live update subscriptions for the state's SECONDARY documents, keyed by URI.
    * Reconciled by {@link reconcileSecondarySubscriptions} after every capture.
    *
    * Held apart from {@link toDispose} because this set is not fixed for the
    * session: a document can leave the write set, and its subscription has to go
    * with it rather than linger until the client detaches.
    */
   protected readonly secondarySubscriptions = new Map<string, Disposable>();

   /**
    * Whether an external resubmit has ever been dispatched. Gates the
    * keep-the-last-valid-GModel branch, which needs to know a canvas is already
    * standing — not what is on it. The content comparison that decides whether a
    * resubmit is worth dispatching lives on the submission handler, which is the
    * only place that sees operation submits too.
    */
   protected hasSubmittedExternally = false;

   /**
    * Trailing-edge debounce for the external resubmit. Rescheduled on each
    * {@link handleModelUpdated} so back-to-back rebuilds (cascade relinks,
    * referenced-document edits) collapse into one {@link doUpdateAndSubmit}.
    * Constructed in {@link init} (the injected {@link ServerSharedServices} —
    * hence its `Clock` — is available by then); disposed on session teardown.
    */
   protected resubmitDebouncer!: Debouncer;

   /** Latest event document awaiting the debounced resubmit; read by {@link flushResubmit} (last write wins). */
   protected pendingResubmitDocument?: AstDocument<AstNode, unknown>;

   @postConstruct()
   protected init(): void {
      this.resubmitDebouncer = new Debouncer(this.sharedServices.Clock, () => this.flushResubmit(), {
         delayMs: EXTERNAL_SUBMIT_DEBOUNCE_MS
      });
      if (this.state.clientId === TEMPORARY_CLIENT_ID) {
         return;
      }
      this.sessionManager.addListener(this, this.state.clientId);
      // Watched for this storage's whole lifetime rather than per load. The load
      // flow is a documented override point, so a subscription parked there would
      // go with it — and the write set is discovered by operation handlers, which
      // run long after any load.
      this.toDispose.push(this.state.onSecondaryUrisChanged(() => this.reconcileSecondarySubscriptions()));
   }

   /**
    * Default load flow — {@link doLoadSourceModel}. Adopters whose load flow
    * needs more than the seams allow override this method.
    */
   loadSourceModel(action: RequestModelAction): MaybePromise<void> {
      return this.doLoadSourceModel(action);
   }

   protected async doLoadSourceModel(action: RequestModelAction): Promise<void> {
      const sourceUri = this.getSourceUri(action);
      const rootUri = this.toSourceModelUri(sourceUri);
      const modelService = this.sharedServices.model.ModelService;

      // Open FIRST: a workspace-scanned-but-never-didOpened document rebuilds here,
      // so the capture below settles on a built root rather than a transient
      // mid-rebuild one.
      this.toDispose.push(await modelService.open({ uri: rootUri, clientId: this.state.clientId }));

      // GLSP's sessionDisposed is unreliable on Theia tab-close; dispose on client
      // detach so reopens don't accumulate stale onModelUpdated listeners.
      this.toDispose.push(
         modelService.onClientClosed(rootUri, this.state.clientId, () => {
            this.logger.info(`Client detached (${this.state.clientId}) — disposing storage subscriptions for ${rootUri}`);
            this.dispose();
         })
      );

      // React to external rebuilds: settle-gated capture + debounced/deduped resubmit.
      this.toDispose.push(modelService.onModelUpdated(rootUri, event => this.handleModelUpdated(rootUri, event)));

      // Coordinate the command stack's dirty state when another client saves.
      this.toDispose.push(modelService.onModelSaved(rootUri, event => this.handleModelSaved(event)));

      // Capture the initial settled root.
      const document = await modelService.settled(rootUri);
      await this.captureSettledRoot(rootUri, document);
   }

   /**
    * Capture the initial settled root and apply the initial edit mode. `settled()`
    * strips diagnostics by phase contract, so the first edit mode is `EDITABLE`;
    * the first {@link handleModelUpdated} (at `Validated`, with diagnostics) flips
    * it READONLY if the document has structural parse errors. Edit-mode +
    * settle-hook actions are dispatched on a macrotask so the initial
    * `requestModel → setModel` handshake isn't perturbed.
    */
   protected async captureSettledRoot(rootUri: string, document: AstDocument<AstNode, never>): Promise<void> {
      this.state.setSourceRoot(rootUri, document.root as TRoot);
      const actions = [...this.refreshEditMode(document), ...this.onSourceModelSettled(document)];
      if (actions.length > 0) {
         // Defer through the injectable Clock (not raw setTimeout) so the dispatch is
         // testable and cancels on session disposal; parked on toDispose for that.
         this.toDispose.push(this.sharedServices.Clock.setTimer(() => this.actionDispatcher.dispatchAll(actions), 0));
      }
   }

   /**
    * Reconcile {@link secondarySubscriptions} against the state's current
    * secondary write set: dispose what left it, subscribe what arrived. Driven by
    * {@link AbstractHydraniumGlspState.onSecondaryUrisChanged}, so it runs when
    * the set actually changes rather than at points a caller guessed it might.
    *
    * **Secondaries need a subscription of their own because nothing else
    * notifies for them.** The state records a secondary's version for the
    * write-side conflict gate and adopter GModel factories re-read secondary
    * content on every build, but no rebuild of a secondary reaches the primary's
    * subscription: Langium's affected-documents walk runs from the referenced
    * document to the referencing one, so a document that references the primary
    * is downstream of it and editing it correctly affects nothing upstream.
    * Manufacturing that invalidation to obtain a notification would cost a real
    * rebuild per edit and make the affected set mean two things — the missing
    * piece is a subscription, not an invalidation.
    */
   protected reconcileSecondarySubscriptions(): void {
      const current = new Set(this.state.secondaryUris);
      for (const [uri, subscription] of this.secondarySubscriptions) {
         if (!current.has(uri)) {
            subscription.dispose();
            this.secondarySubscriptions.delete(uri);
         }
      }
      for (const uri of current) {
         if (!this.secondarySubscriptions.has(uri)) {
            this.secondarySubscriptions.set(
               uri,
               this.sharedServices.model.ModelService.onModelUpdated(uri, event => this.handleSecondaryUpdated(uri, event))
            );
         }
      }
   }

   /**
    * React to a rebuild of a SECONDARY document by resubmitting the diagram, so
    * an external edit to (say) a layout file reaches the canvas.
    *
    * Reuses {@link handleModelUpdated}'s authorship guard, and that is the load-
    * bearing half rather than the resubmit: a diagram interaction that writes a
    * secondary — a drag persisting bounds to a layout file — comes back through
    * this listener as the client's own `changed` edit, and resubmitting on it
    * fights the optimistic client-side move the user is still holding.
    *
    * Schedules the PRIMARY's current document, never the secondary's.
    * {@link doUpdateAndSubmit} reads its event document only for the edit-mode
    * and structurally-broken decisions, both of which are statements about the
    * document the canvas edits: passing the secondary's would let a typo in a
    * layout file flip the canvas READONLY and take the keep-the-last-valid-GModel
    * branch off an unrelated document's parse state. The pending-document field
    * is shared with the primary path, so it would poison a concurrently
    * scheduled primary resubmit too.
    *
    * No marker refresh, unlike the primary path: a secondary's diagnostics reach
    * the client only if an adopter's index registers elements as rendering that
    * document, and refreshing here unconditionally would add a dispatch to every
    * drag this client authors — the guard above gates the resubmit, not the
    * markers.
    */
   protected handleSecondaryUpdated(uri: string, event: AstDocumentUpdatedEvent<AstNode, unknown>): void {
      if (this.disposeIfStale(uri)) {
         return;
      }
      if (this.state.clientId === event.sourceClientId && event.reason === 'changed') {
         return;
      }
      const primary = this.currentPrimaryDocument();
      if (primary === undefined) {
         return;
      }
      this.logger.debug(`Secondary ${uri} rebuilt by ${event.sourceClientId} (${event.reason}) — scheduling resubmit`);
      this.scheduleUpdateAndSubmit(primary);
   }

   /**
    * The primary document's current state, or `undefined` when it is not
    * registered.
    *
    * Synchronous by construction — the phase-agnostic lookup door plus the shared
    * projection — so reacting to a secondary neither waits nor can force a build.
    * `settled()` is not an alternative: it strips diagnostics by phase contract,
    * and diagnostics are the reason {@link doUpdateAndSubmit} takes a separate
    * event document at all.
    */
   protected currentPrimaryDocument(): AstDocument<AstNode, unknown> | undefined {
      const document = this.sharedServices.model.ModelService.getDocument(this.state.sourceUri);
      return document ? AstDocument.from(document) : undefined;
   }

   /**
    * React to an external rebuild reaching `Validated`. Self-cleans if the
    * session has vanished but this listener leaked (neither `sessionDisposed`
    * nor `onClientClosed` fired on tab close). Resubmits for any change not
    * authored by this client's own optimistic `changed` edit, then refreshes
    * diagnostic markers for every update — including own edits, which skip
    * the resubmit but can still change diagnostics.
    */
   protected async handleModelUpdated(rootUri: string, event: AstDocumentUpdatedEvent<AstNode, unknown>): Promise<void> {
      if (this.disposeIfStale(rootUri)) {
         return;
      }
      if (this.state.clientId !== event.sourceClientId || event.reason !== 'changed') {
         this.scheduleUpdateAndSubmit(event.document);
      }
      await this.refreshDiagnosticMarkers();
   }

   /**
    * Whether this storage has outlived its session — disposing it as a side
    * effect when so. Checked from every subscription entry point because GLSP's
    * `sessionDisposed` is unreliable on Theia tab-close and `onClientClosed` can
    * miss it as well; a listener that survives its session otherwise keeps firing
    * for the life of the process. `context` names the document whose event
    * surfaced the leak.
    */
   protected disposeIfStale(context: string): boolean {
      if (this.sessionManager.getSession(this.state.clientId)) {
         return false;
      }
      this.logger.warn(`Stale storage (clientId=${this.state.clientId} not in ClientSessionManager) — self-disposing ${context}`);
      this.dispose();
      return true;
   }

   /**
    * Record the latest document and (re)arm the trailing-edge
    * {@link resubmitDebouncer}, so a burst of rebuilds runs
    * {@link doUpdateAndSubmit} once with the most recent document.
    */
   protected scheduleUpdateAndSubmit(document: AstDocument<AstNode, unknown>): void {
      this.pendingResubmitDocument = document;
      this.resubmitDebouncer.schedule();
   }

   /**
    * Debouncer callback: run the resubmit for the latest pending document
    * against this storage's (invariant) source URI and dispatch the result.
    * Fire-and-forget — failures are logged, not surfaced to the timer caller.
    */
   protected flushResubmit(): void {
      const document = this.pendingResubmitDocument;
      if (document === undefined) {
         return;
      }
      const rootUri = this.state.sourceUri;
      this.doUpdateAndSubmit(rootUri, document).then(
         actions => this.actionDispatcher.dispatchAll(actions),
         error => this.logger.error(`Update-and-submit failed for ${rootUri}: ${error instanceof Error ? error.message : String(error)}`)
      );
   }

   /**
    * Coordinate the command stack when another client persists the document:
    * mark our stack clean so the editor doesn't prompt to re-save identical
    * content. Our own saves already settle the stack through the save flow.
    */
   protected handleModelSaved(event: AstDocumentSavedEvent<AstNode, unknown>): void {
      if (this.state.clientId !== event.sourceClientId) {
         this.commandStack.saveIsDone();
      }
   }

   /**
    * Re-settle to a guaranteed fully-linked + reprojected root, capture it, and
    * (unless suppressed) resubmit a deduped external GModel. Diagnostics for the
    * edit-mode decision come from the event document (`settled()` strips them by
    * phase contract).
    */
   protected async doUpdateAndSubmit(rootUri: string, eventDocument: AstDocument<AstNode, unknown>): Promise<Action[]> {
      // Settle-gate the capture: never setSourceRoot off the event's possibly-transient
      // snapshot — the event can arrive while a re-entered document is mid-rebuild.
      const document = await this.sharedServices.model.ModelService.settled(rootUri);
      this.state.setSourceRoot(rootUri, document.root as TRoot);
      const editModeActions = this.refreshEditMode(eventDocument);

      // Skip the external submit until the initial requestModel completes; submitting too
      // early bumps root.revision and the client's stale first computedBounds is dropped,
      // leaving the canvas empty.
      if (this.submissionHandler.hasPendingInitialRequest()) {
         return editModeActions;
      }
      // While the AST is structurally broken, keep the last valid GModel so the canvas
      // doesn't blank mid-typing. READONLY is still flipped for user feedback.
      if (this.isStructurallyBroken(eventDocument) && this.hasSubmittedExternally) {
         return editModeActions;
      }
      // Read the handler's signature BEFORE submitting and again after: it records
      // every submission whatever the reason, so an unmoved signature means this
      // rebuild produced the graph the client already has. Comparing only against
      // our own previous EXTERNAL submit cannot see that, which is why a drag used
      // to be answered by an echo of itself — the operation had delivered the
      // model, and the external comparison had never heard of it.
      const previousSignature = this.submissionHandler.lastSubmittedSignature;
      const submitActions = await this.submissionHandler.submitModel('external');
      if (this.submissionHandler.lastSubmittedSignature === previousSignature) {
         return editModeActions;
      }
      this.hasSubmittedExternally = true;
      return [...submitActions, ...editModeActions];
   }

   /**
    * Recompute the desired edit mode from the document's structural-error state,
    * flip {@link AbstractHydraniumGlspState.editMode}, and — only on a transition —
    * return the {@link onParseErrorChanged} actions. No transition → no actions.
    */
   protected refreshEditMode(document: AstDocument<AstNode, unknown>): Action[] {
      const broken = this.isStructurallyBroken(document);
      const previousEditMode = this.state.editMode;
      this.state.editMode = broken ? EditMode.READONLY : EditMode.EDITABLE;
      if (previousEditMode === this.state.editMode) {
         return [];
      }
      return this.onParseErrorChanged(document, broken);
   }

   /**
    * Seam: is the AST structurally broken (lexing/parsing errors)? Drives both
    * READONLY mode and the GModel resubmit skip — keeping the last valid canvas
    * instead of blanking it mid-typing. Default: any error-severity diagnostic
    * carrying a Langium `lexing-error` / `parsing-error` code. Adopters override
    * to compose additional break reasons.
    */
   protected isStructurallyBroken(document: AstDocument<AstNode, unknown>): boolean {
      return document.diagnostics.some(diagnostic => isStructuralDiagnostic(diagnostic));
   }

   /**
    * Seam: actions to emit when the structural-broken state transitions. Default:
    * a single {@link SetEditModeAction} toggling READONLY ↔ EDITABLE — editing is
    * disabled while the syntax is broken but re-enabled once it parses, a sound
    * generic for any Langium-backed diagram. Adopters override to add or replace
    * the transition feedback. The {@link AbstractHydraniumGlspState.editMode}
    * flip itself is owned by {@link refreshEditMode}.
    */
   protected onParseErrorChanged(_document: AstDocument<AstNode, unknown>, broken: boolean): Action[] {
      return [SetEditModeAction.create(broken ? EditMode.READONLY : EditMode.EDITABLE)];
   }

   /**
    * Seam: extra actions to dispatch right after the initial settled root is
    * captured (e.g. an adopter-specific status or palette refresh). Default: none.
    */
   protected onSourceModelSettled(_document: AstDocument<AstNode, never>): Action[] {
      return [];
   }

   /** The effective {@link SaveConflictPolicy}: the bound option, or {@link DEFAULT_SAVE_CONFLICT_POLICY} when unbound. */
   protected get saveConflictPolicy(): SaveConflictPolicy {
      return this.boundSaveConflictPolicy ?? DEFAULT_SAVE_CONFLICT_POLICY;
   }

   /**
    * Default save flow: route through `ModelService.save`. The framework
    * serialise-and-persist machinery handles serialisation (via the
    * language-specific `Serializer` bound at `services.serializer.Serializer`),
    * the multi-client text-document update, the rebuild, and the eventual
    * `WritableFileSystemProvider.writeFile`.
    *
    * The configured {@link SaveConflictPolicy} (see {@link saveConflictPolicy})
    * decides how a concurrent edit that advanced the document is handled:
    * - `overwrite` (default): no based-on guard, await, propagate failures —
    *   last-write-wins, correct for a single-editor head.
    * - `reject`: guard on the captured `state.version`, await, surface a
    *   `ConflictError` (and any other failure) to the GLSP save action.
    * - `drop-and-log`: guard, fire-and-forget, log + swallow failures — a stale
    *   diagram save is dropped because a concurrent form/code edit already wrote
    *   the truth, and GLSP exposes no save-failure back-channel.
    *
    * Returns `MaybePromise<void>` to match upstream `SourceModelStorage`:
    * resolves with the persist under `overwrite`/`reject`, returns synchronously
    * under `drop-and-log`. Adopters that bypass `ModelService` (writing through
    * `WritableFileSystemProvider` directly) still override the whole method.
    */
   saveSourceModel(action: SaveModelAction): MaybePromise<void> {
      // Normalised for the same reason the load path is: `SaveModelAction.fileUri`
      // is client-supplied on a "Save As" and carries whichever form that client
      // uses. The state fallback is already a URI string, and normalising one is
      // idempotent, so this only changes the client-supplied branch. Applied at
      // the call site rather than inside `getFileUri` so that method's contract —
      // return what the action said — is unchanged for adopters overriding it.
      const uri = this.toSourceModelUri(this.getFileUri(action));
      const policy = this.saveConflictPolicy;
      const persisted = this.sharedServices.model.ModelService.save({
         uri,
         model: this.state.sourceRoot,
         clientId: this.state.clientId,
         baseVersion: policy.kind === 'overwrite' ? undefined : this.state.version
      }).then(() => undefined);

      if (policy.kind === 'drop-and-log') {
         // Fire-and-forget: the diagram save lost the race to a concurrent edit
         // that already persisted the truth, so it must neither block the action
         // nor surface. Log rather than leave an unhandled rejection.
         persisted.catch(error => this.logger.error(`Save failed for ${uri}: ${error instanceof Error ? error.message : String(error)}`));
         return undefined;
      }
      // overwrite / reject: await; a ConflictError (reject) or any other failure
      // propagates to GLSP's save-action handler.
      return persisted;
   }

   /**
    * Normalise GLSP's `sourceUri` — which may be a filesystem PATH or a URI
    * string — to the URI string the workspace keys documents by.
    *
    * **The protocol does not pin which form a client sends, and the clients in
    * play disagree.** GLSP's VS Code integration sends `document.uri.toString()`;
    * a headless caller passes the path it already has. Committing to either one
    * alone is what this method exists to avoid.
    *
    * **Getting it wrong does not throw where the mistake is.** `URI.file` given
    * a URI string treats the whole thing as a path, percent-encodes the scheme,
    * and yields an `fsPath` with that scheme buried in the middle. Nothing
    * rejects it; it travels down to the filesystem and surfaces as an ENOENT
    * several layers from the coercion that produced it.
    *
    * Adopters whose client sends a third form override this.
    */
   protected toSourceModelUri(sourceUri: string): string {
      return URI_SCHEME.test(sourceUri) ? URI.parse(sourceUri).toString() : URI.file(sourceUri).toString();
   }

   /**
    * Extract the source URI from a {@link RequestModelAction}. Throws
    * {@link GLSPServerError} if the option is missing or non-string —
    * GLSP's protocol contract requires the client to pass `sourceUri`
    * when initiating a model request.
    *
    * Returns it VERBATIM, in whatever form the client sent;
    * {@link toSourceModelUri} is what normalises it.
    *
    * A model request DOES carry a request id, so a throw here takes the
    * client-request path rather than the toast path — and on that path `detail`
    * comes from `cause?.toString?.()`. A single-argument throw therefore reaches
    * neither the server log nor the client console: both print `undefined`. So
    * the two readers are addressed separately, as on the save path: `message`
    * names what failed in the user's terms and is rendered, `cause` names the
    * action and the option key that was missing and stays English. On THIS path
    * the cause reaches only logs — `RejectAction.detail` is read by nothing but
    * the client action-dispatcher's `logger.warn` — which is not what makes it
    * English; its content is.
    */
   protected getSourceUri(action: RequestModelAction): string {
      const sourceUri = action.options?.[SOURCE_URI_ARG];
      if (typeof sourceUri !== 'string') {
         throw new GLSPServerError(
            this.sharedServices.MessageRenderer.renderMessage(SOURCE_URI_MISSING),
            `no '${SOURCE_URI_ARG}' option on the ${action.kind} action (received ${typeof sourceUri})`
         );
      }
      return sourceUri;
   }

   /**
    * Resolve the URI to save to: prefer the {@link SaveModelAction.fileUri}
    * (set when the user chose "Save As"), fall back to the
    * {@link SOURCE_URI_ARG} mirrored into the inherited properties map by
    * {@link AbstractHydraniumGlspState.setSourceRoot}.
    *
    * A save action carries no request id, so a throw here reaches the user as a
    * toast built from `message`, while `cause` travels in
    * `MessageAction.details` — **which a Theia host DOES put in front of a
    * user**, as a "Show details" button on the toast opening a dialog. So the
    * two are not split by reachability; they are split by AUDIENCE, which is
    * the older rule and the one that holds here. The message names what failed
    * in the user's terms and is rendered; the cause names which lookups came
    * back empty for whom, and stays English because a wire action kind, an
    * option key and a client id address whoever composes the system — a
    * translated developer string is a worse outcome than an untranslated one.
    * Neither can name the URI — not having one IS the failure, and both sources
    * are written together, so the typed `sourceUri` is equally empty whenever
    * this fires.
    */
   protected getFileUri(action: SaveModelAction): string {
      const uri = action.fileUri ?? this.state.get<string>(SOURCE_URI_ARG);
      if (!uri) {
         throw new GLSPServerError(
            this.sharedServices.MessageRenderer.renderMessage(SAVE_TARGET_UNKNOWN),
            `no fileUri on the save action and no ${SOURCE_URI_ARG} in the model state (clientId=${this.state.clientId})`
         );
      }
      return uri;
   }

   /**
    * Recompute the bound {@link ModelValidator}'s markers and push them to the
    * client as a `SetMarkersAction` — asynchronously and independently of model
    * rendering. Called from {@link handleModelUpdated} (which fires at `Validated`),
    * so diagram markers refresh without gating the diagram submit on validation.
    * No-op when no validator is bound.
    *
    * Always dispatched under {@link MarkersReason.BATCH}: the GLSP client's
    * `ValidationFeedbackEmitter` keys feedback by reason and replaces the prior
    * set, so re-pushing the full set clears stale markers (an empty set clears
    * all once the model is valid), and sharing the tool-palette validate
    * command's `BATCH` reason means the two paths replace rather than duplicate.
    */
   async refreshDiagnosticMarkers(): Promise<void> {
      if (!this.modelValidator) {
         return;
      }
      const markers = await this.modelValidator.validate([this.state.root], MarkersReason.BATCH);
      this.actionDispatcher.dispatch(SetMarkersAction.create(markers, { reason: MarkersReason.BATCH }));
   }

   sessionDisposed(_clientSession: ClientSession): void {
      this.dispose();
   }

   /**
    * Cancel any pending resubmit and drain every subscription — those registered
    * during {@link doLoadSourceModel} and the per-secondary ones, which live
    * outside {@link toDispose} because they come and go with the write set.
    * Idempotent.
    */
   dispose(): void {
      this.resubmitDebouncer?.dispose();
      for (const subscription of this.secondarySubscriptions.values()) {
         subscription.dispose();
      }
      this.secondarySubscriptions.clear();
      this.toDispose.dispose();
   }
}
