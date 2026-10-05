/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MarkersReason, MessageAction, SetMarkersAction } from '@eclipse-glsp/protocol';
import {
   type Action,
   ActionDispatcher,
   type ClientSession,
   type ClientSessionListener,
   ClientSessionManager,
   CommandStack,
   type DefaultCommandStack,
   type Disposable,
   GLSPServerError,
   Logger as GlspLogger,
   type MaybePromise,
   ModelState,
   ModelSubmissionHandler,
   ModelValidator,
   type RequestModelAction,
   SOURCE_URI_ARG,
   type SaveModelAction,
   SetDirtyStateAction,
   type SourceModelStorage,
   TEMPORARY_CLIENT_ID
} from '@eclipse-glsp/server';
import {
   Debouncer,
   defineMessage,
   DisposableCollection,
   isDuplicateClientIdError,
   isSessionClosedError,
   RESUME_TOKEN_ARG,
   SessionClosedError
} from '@hydranium/protocol';
import { inject, injectable, optional, postConstruct } from 'inversify';
import { type AstNode, type ParseResult } from '@hydranium/langium';
import { URI, UriUtils } from '@hydranium/langium';
import {
   type AstDocument,
   type AstDocumentSavedEvent,
   type AstDocumentUpdatedEvent,
   type ClientSession as ModelClientSession,
   type ModelDirtyChangedEvent,
   type ServerSharedServices,
   type SessionEndCause
} from '@hydranium/core';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { DiagramStatus, type DiagramStatusEntry } from '../state/diagram-status.js';
import { type HydraniumGlspSubmissionHandler } from '../submission/hydranium-glsp-submission-handler.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { DEFAULT_SAVE_DELIVERY_POLICY, SaveDeliveryPolicy } from './save-delivery-policy.js';

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

/**
 * Why the canvas has stopped accepting edits.
 *
 * **A READONLY canvas is otherwise indistinguishable from a broken one.** The
 * client's answer to a read-only edit mode is to withdraw the tool palette,
 * so the surface a reader was working in silently loses the only control it had,
 * with the cause — a syntax error in a document that may not even be open —
 * nowhere on screen. The mode flip is the mechanism; this is the only part of it
 * a user can see.
 *
 * Rendered at the raise site, like its two siblings above and for the same
 * reason: every member of GLSP's status action is prose or an enum.
 *
 * It names the document and the recovery rather than the fault, because the
 * fault already has a surface — the squiggle and the problems list, both of which
 * say WHICH character — and repeating it here would put a second, less precise
 * account of the same error on screen. What no other surface says is that the
 * diagram is waiting on it, and the document it waits on need not be the one
 * the diagram was opened on.
 */
export const DIAGRAM_READONLY_PARSE_ERROR = defineMessage(
   'hydranium/glsp-server/diagram-readonly-parse-error',
   'Read-only: {document} has a syntax error. Fix it to edit the diagram again.'
);

/**
 * The diagram's GLSP client id is still live as another participant's client
 * id once the load has waited for it to free, so the diagram does not load.
 *
 * Rendered at the raise site, as {@link SAVE_TARGET_UNKNOWN} is and for the
 * same reason, and dispatched to the client as a message of its own: a model
 * request fails as a rejection whose detail is the English cause, which no user
 * sees. It names the recovery: a host that numbers its diagram clients gives a
 * reopened diagram a fresh id.
 */
export const DIAGRAM_SESSION_REFUSED = defineMessage(
   'hydranium/glsp-server/diagram-session-refused',
   'Could not open this diagram: its identifier is still in use by another editor. Close the diagram and open it again.'
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

/** Whether `parseResult` holds what Langium's validator reports as an error-severity `lexing-error` or `parsing-error`. */
function hasStructuralErrors(parseResult: ParseResult): boolean {
   const lexing = parseResult.lexerReport?.diagnostics ?? [];
   return (
      parseResult.parserErrors.length > 0 ||
      parseResult.lexerErrors.length > 0 ||
      lexing.some(diagnostic => (diagnostic.severity ?? 'error') === 'error')
   );
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
 * the storage performs captures a root that has reached
 * `IntegrityService.SettledState` (post-`Linked`, references indexed, on-build
 * integrity rules applied). The end of an operation captures the root its
 * write produced, settled or not, and the operation's own submit waits for the
 * settled one through `ready()`. The GModel factory therefore always walks a
 * fully linked + reprojected AST. The resubmit path re-`settled()`s rather
 * than keeping the `onModelUpdated` event's document: the event's document
 * holds only while its listener runs, and the resubmit runs after a debounce,
 * by which time another build can have reset it.
 *
 * Adopters with richer needs override the seams ({@link isStructurallyBroken},
 * {@link parseErrorStatus}, {@link onSourceModelSettled}) rather than the
 * whole flow, and select a {@link SaveDeliveryPolicy} via the bound option to
 * tune how {@link saveSourceModel} delivers its result.
 *
 * **One client session per GLSP client session.** The load registers the GLSP
 * client id as a client session ({@link registerModelSession}), with the
 * request's {@link RESUME_TOKEN_ARG}, and hands it to the state as
 * `modelSession`. The primary is opened through it, and
 * every document that joins the write set as it joins
 * ({@link openSecondary}); a document that leaves the write set stays open
 * until the next save, so leaving never reverts the diagram's unsaved edits to
 * it. Disposing the storage ends the session, which closes everything it has
 * open.
 *
 * **Default `saveSourceModel` flow.** Flushes the stored text of every
 * document the diagram's session has open through the session's `persist`, with
 * no serializer in the path — the update path already put the settled text in
 * the store. The bound {@link SaveDeliveryPolicy} (default
 * {@link DEFAULT_SAVE_DELIVERY_POLICY}, `await`) decides
 * await-vs-fire-and-forget and failure handling.
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
 * {@link toDispose} idempotently and then ends the client session. The
 * framework's GLSP server disposes the storage as lost first when it shuts
 * down, which is how the client's connection ending reaches it, so the
 * diagram's unsaved text waits out the revert grace. Every
 * transient subscription created in {@link doLoadSourceModel} is parked on
 * {@link toDispose} so the drain catches them on client-detach.
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
    * Selected {@link SaveDeliveryPolicy} for {@link saveSourceModel}. Bind the
    * {@link SaveDeliveryPolicy} token in a `DiagramModule` to choose a policy;
    * left unbound it resolves to {@link DEFAULT_SAVE_DELIVERY_POLICY}. Read via
    * {@link saveDeliveryPolicy} so the fallback is applied even when inversify
    * injects `undefined` for an unbound `@optional()` member.
    */
   @inject(SaveDeliveryPolicy) @optional() protected readonly boundSaveDeliveryPolicy?: SaveDeliveryPolicy;

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
    * Documents that left the write set since the last save. They stay open in
    * the diagram's session until that save has persisted them, and are closed
    * after it: closing a document as it leaves would revert the diagram's
    * unsaved edits to it where the diagram was its last client.
    */
   protected readonly departedSecondaries = new Set<string>();

   /** How long a load without a resume token waits for a held client id to free; see {@link loadModelSession}. */
   protected readonly sessionWaitMs: number = 2_000;

   /** Set by {@link dispose}; a disposed storage registers no session again. */
   protected disposed = false;
   /** Saves of the diagram's own that GLSP's save handler awaits; see {@link handleDirtyChanged}. */
   protected ownSavesPending = 0;

   /**
    * Trailing-edge debounce for the external resubmit. Rescheduled on each
    * {@link handleModelUpdated} so back-to-back rebuilds (cascade relinks,
    * referenced-document edits) collapse into one {@link doUpdateAndSubmit}.
    * Constructed in {@link init} (the injected {@link ServerSharedServices} —
    * hence its `Clock` — is available by then); disposed on session teardown.
    */
   protected resubmitDebouncer!: Debouncer;

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
    * Register the diagram's client session under the GLSP client id, or
    * `undefined` when another participant holds that id, which is logged, and
    * the diagram then refuses to load ({@link requireModelSession}). Taking
    * the id over would end that participant's session under it, and working
    * without a session would share its opens and echoes, so its close would
    * take the diagram's documents with it.
    *
    * The exception is a `resumeToken` the holder registered with, which takes
    * its session over: a diagram that reconnected or reloaded, whose old
    * connection the server has not seen close yet.
    *
    * A client id the framework reserves throws `ReservedClientIdError`:
    * whoever chose the GLSP client id has a bug, and no later registration can
    * succeed.
    */
   protected registerModelSession(resumeToken?: string): ModelClientSession<AstNode> | undefined {
      try {
         return this.sharedServices.model.ModelService.createSession('diagram', this.state.clientId, { resumeToken });
      } catch (error: unknown) {
         if (!isDuplicateClientIdError(error)) {
            throw error;
         }
         this.logger.warn(`Client id ${this.state.clientId} is held by another participant: this diagram has no session yet`);
         return undefined;
      }
   }

   /**
    * The diagram's client session. Throws `SessionClosedError` once the
    * storage is disposed, and the refusal before a load has registered one.
    * Registering here instead would start the session without the load's
    * resume token, which a later resume then fails to match.
    */
   protected requireModelSession(): ModelClientSession<AstNode> {
      if (this.disposed) {
         throw new SessionClosedError(this.state.clientId, 'The diagram has closed; its client session has ended.');
      }
      const session = this.state.modelSession;
      if (!session) {
         throw new GLSPServerError(
            this.sharedServices.MessageRenderer.renderMessage(DIAGRAM_SESSION_REFUSED),
            `clientId=${this.state.clientId} has no client session: no load has registered it, or another participant holds the id`
         );
      }
      return session;
   }

   /**
    * {@link requireModelSession} for the load, registering with the request's
    * resume token, and telling the user when the id is refused. A load with
    * no token waits up to {@link sessionWaitMs} for a held id to free: a
    * client that resumes no session reconnects under its old id before the
    * server has seen the old connection close.
    */
   protected async loadModelSession(action: RequestModelAction): Promise<ModelClientSession<AstNode>> {
      const option = action.options?.[RESUME_TOKEN_ARG];
      const token = typeof option === 'string' ? option : undefined;
      if (!this.state.modelSession && !this.disposed) {
         this.state.modelSession = this.registerModelSession(token);
      }
      if (!this.state.modelSession && !this.disposed && token === undefined) {
         await this.waitForSessionEnd(this.state.clientId, this.sessionWaitMs);
         if (!this.state.modelSession && !this.disposed) {
            this.state.modelSession = this.registerModelSession();
         }
      }
      try {
         return this.requireModelSession();
      } catch (error: unknown) {
         // A diagram closed meanwhile has no client left to tell.
         if (isSessionClosedError(error)) {
            throw error;
         }
         this.logger.error(`Client id ${this.state.clientId} is still held by another participant: this diagram does not load`);
         this.actionDispatcher
            .dispatch(
               MessageAction.create(this.sharedServices.MessageRenderer.renderMessage(DIAGRAM_SESSION_REFUSED), { severity: 'ERROR' })
            )
            .catch((dispatchError: unknown) =>
               this.logger.warn(`Could not tell the client the diagram was refused: ${String(dispatchError)}`)
            );
         throw error;
      }
   }

   /** Resolve once the client session under `clientId` ends, or after `timeoutMs`. */
   protected waitForSessionEnd(clientId: string, timeoutMs: number): Promise<void> {
      return new Promise<void>(resolve => {
         const subscriptions = new DisposableCollection();
         const done = (): void => {
            subscriptions.dispose();
            resolve();
         };
         subscriptions.push(this.sharedServices.Clock.setTimer(done, timeoutMs));
         // A holder this service did not start is waited out by the timer.
         const holder = this.sharedServices.model.ModelService.getSession(clientId);
         if (holder) {
            subscriptions.push(holder.onDidDispose(done));
         }
      });
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
      // mid-rebuild one. Closed when the session ends.
      await (await this.loadModelSession(action)).open(rootUri);

      // GLSP's sessionDisposed is unreliable on Theia tab-close; dispose on client
      // detach so reopens don't accumulate stale onModelUpdated listeners.
      this.toDispose.push(
         modelService.onClientClosed(
            () => {
               this.logger.info(`Client detached (${this.state.clientId}) — disposing storage subscriptions for ${rootUri}`);
               this.dispose();
            },
            { uri: rootUri, clientId: this.state.clientId }
         )
      );

      // React to external rebuilds: settle-gated capture + debounced/deduped resubmit.
      this.toDispose.push(modelService.onModelUpdated(event => this.handleModelUpdated(rootUri, event), { uri: rootUri }));

      // GLSP's own command stack counts commands; tell it of another client's save.
      this.toDispose.push(modelService.onModelSaved(event => this.handleModelSaved(event), { uri: rootUri }));

      // Tell the client of each dirty flip, one the diagram did not cause included.
      this.toDispose.push(modelService.onDirtyChanged(event => this.handleDirtyChanged(event)));

      // Capture the initial settled root.
      const document = await modelService.settled(rootUri);
      await this.captureSettledRoot(rootUri, document);
   }

   /**
    * Capture the initial settled root and its parse-error status. Settle-hook
    * actions are dispatched on a macrotask so the initial
    * `requestModel → setModel` handshake isn't perturbed.
    *
    * The initial status is decided from the root's own parse (see
    * {@link isStructurallyBroken}), not from diagnostics: `settled()` can hand
    * back a document it drove to the integrity landmark, before validation,
    * with no diagnostics yet.
    */
   protected async captureSettledRoot(rootUri: string, document: AstDocument<AstNode, never>): Promise<void> {
      await this.state.runExclusive(() => this.state.setSourceRoot(rootUri, document.root as TRoot));
      this.refreshParseErrorStatus(document);
      const actions = this.onSourceModelSettled(document);
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
            this.departedSecondaries.add(uri);
         }
      }
      for (const uri of current) {
         if (!this.secondarySubscriptions.has(uri)) {
            this.departedSecondaries.delete(uri);
            this.secondarySubscriptions.set(
               uri,
               this.sharedServices.model.ModelService.onModelUpdated(event => this.handleSecondaryUpdated(uri, event), { uri })
            );
            this.openSecondary(uri);
         }
      }
   }

   /**
    * Open a document that joined the write set through the diagram's session,
    * where it stays open until the diagram's next save after it leaves the set,
    * or the diagram's end. A document that does not exist yet is left to the
    * write that creates it, and a failed open is logged: the write that needs
    * the document opens it again and fails there.
    */
   protected openSecondary(uri: string): void {
      const session = this.state.modelSession;
      if (!session || !this.sharedServices.model.ModelService.getDocument(uri)) {
         return;
      }
      session.open(uri).catch((error: unknown) => {
         const detail = `Could not open ${uri} for ${this.state.clientId}: ${error instanceof Error ? error.message : String(error)}`;
         // A session ending while the open reads is the diagram closing.
         if (isSessionClosedError(error)) {
            this.logger.debug(detail);
         } else {
            this.logger.warn(detail);
         }
      });
   }

   /**
    * React to a rebuild of a SECONDARY document by resubmitting the diagram, so
    * an external edit to (say) a layout file reaches the canvas.
    *
    * Applies {@link handleModelUpdated}'s guard, and that is the load-bearing
    * half rather than the resubmit: a diagram interaction that writes a
    * secondary — a drag persisting bounds to a layout file — comes back through
    * this listener caused by the client's own write, and resubmitting on it
    * fights the optimistic client-side move the user is still holding.
    *
    * No marker refresh, unlike the primary path: a secondary's diagnostics reach
    * the client only if an adopter's index registers elements as rendering that
    * document, and refreshing here unconditionally would add a dispatch to every
    * drag this client authors — the guard above gates the resubmit, not the
    * markers.
    */
   protected handleSecondaryUpdated(uri: string, event: AstDocumentUpdatedEvent<AstNode>): void {
      if (this.disposeIfStale(uri)) {
         return;
      }
      if (event.causedBy === this.state.clientId || this.currentPrimaryDocument() === undefined) {
         return;
      }
      this.logger.debug(
         `Secondary ${uri} rebuilt, caused by ${event.causedBy ?? 'an unknown client'} (${event.reason}) — scheduling resubmit`
      );
      this.scheduleUpdateAndSubmit();
   }

   /**
    * The primary document's current state, or `undefined` when it is not
    * registered.
    *
    * Synchronous by construction, so the parse-error status reads the text as
    * it stands rather than waiting for a build.
    */
   protected currentPrimaryDocument(): AstDocument<AstNode> | undefined {
      const document = this.sharedServices.model.ModelService.getDocument(this.state.sourceUri);
      return document ? this.sharedServices.workspace.AstDocumentManager.toAstDocument(document) : undefined;
   }

   /**
    * React to an external rebuild reaching `Validated`. Self-cleans if the
    * session has vanished but this listener leaked (neither `sessionDisposed`
    * nor `onClientClosed` fired on tab close). Resubmits for any update this
    * client's own write did not cause alone, then refreshes diagnostic markers
    * for every update — including own writes, which skip the resubmit but can
    * still change diagnostics. An event without `causedBy` is resubmitted.
    *
    * Own writes include a primary that the build of a write to a secondary
    * swept in, which arrives `rebuilt`. Skipping it loses nothing the canvas
    * shows: the operation behind the write submits once the write has
    * answered, and a build steps its whole batch through each phase, so that
    * submit already renders the relinked primary. What the later `Validated`
    * adds are diagnostics, which the marker refresh carries.
    */
   protected async handleModelUpdated(rootUri: string, event: AstDocumentUpdatedEvent<AstNode>): Promise<void> {
      if (this.disposeIfStale(rootUri)) {
         return;
      }
      if (event.causedBy !== this.state.clientId) {
         this.scheduleUpdateAndSubmit();
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
    * (Re)arm the trailing-edge {@link resubmitDebouncer}, so a burst of
    * rebuilds runs {@link doUpdateAndSubmit} once.
    */
   protected scheduleUpdateAndSubmit(): void {
      this.resubmitDebouncer.schedule();
   }

   /**
    * Debouncer callback: run the resubmit against this storage's (invariant)
    * source URI and dispatch the result. Fire-and-forget — failures are
    * logged, not surfaced to the timer caller.
    */
   protected flushResubmit(): void {
      const rootUri = this.state.sourceUri;
      this.doUpdateAndSubmit(rootUri).then(
         actions => this.actionDispatcher.dispatchAll(actions),
         error => this.logger.error(`Update-and-submit failed for ${rootUri}: ${error instanceof Error ? error.message : String(error)}`)
      );
   }

   /**
    * For a diagram module on GLSP's own command stack, which counts commands:
    * mark it clean when another client persists the document.
    * `HydraniumGlspCommandStack` reads the text store instead, and this does
    * not move it.
    */
   protected handleModelSaved(event: AstDocumentSavedEvent<AstNode>): void {
      if (this.state.clientId !== event.sourceClientId) {
         this.commandStack.saveIsDone();
      }
   }

   /**
    * Send the diagram's dirty state when a document it has open turns dirty or
    * clean, the answer being the command stack's. GLSP sends it only with a
    * model submission or a save of the diagram's own, so a save by another
    * client, an editor included, or an edit that changes nothing the diagram
    * shows would otherwise leave the client's marker wrong until the next
    * gesture. A flip the diagram's own operation causes is sent twice, once
    * here and once with the submission, and the client keeps the one state.
    *
    * Nothing is sent while a save of the diagram's own is awaited: GLSP's save
    * handler sends the state once the save settles, reason `save`, and GLSP's
    * client keeps a state only when it changes, so the save's own flip sent
    * here first would leave that answer changing nothing. GLSP's saveable
    * waits for exactly that answer, and times out without it.
    */
   protected handleDirtyChanged(event: ModelDirtyChangedEvent): void {
      if (this.ownSavesPending > 0 || !this.sharedServices.workspace.TextDocuments.isOpenInClient(event.uri, this.state.clientId)) {
         return;
      }
      this.sendDirtyState();
   }

   /** Send the command stack's dirty state, reason `external`. */
   protected sendDirtyState(): void {
      this.actionDispatcher
         .dispatch(SetDirtyStateAction.create(this.commandStack.isDirty, { reason: 'external' }))
         .catch((error: unknown) => this.logger.warn(`Could not send the dirty state of ${this.state.sourceUri}: ${String(error)}`));
   }

   /**
    * Re-settle to a guaranteed fully-linked + reprojected root, capture it, and
    * (unless suppressed) resubmit a deduped external GModel.
    *
    * The settle is awaited outside {@link AbstractHydraniumGlspState.runExclusive},
    * so an operation does not wait on a build; the capture and the render run
    * inside it, the render's own wait for the document included, since an
    * operation opened between that wait and the GModel build would be rendered.
    */
   protected async doUpdateAndSubmit(rootUri: string): Promise<Action[]> {
      const document = await this.sharedServices.model.ModelService.settled(rootUri);
      return this.state.runExclusive(() => this.captureAndSubmit(rootUri, document.root as TRoot));
   }

   /**
    * The part of {@link doUpdateAndSubmit} that runs inside the boundary.
    * `root` is not captured when the state already holds a later one: an
    * operation that ended while the settle was awaited captured its own
    * write, which `root` predates.
    *
    * The parse-error status is the primary's as it stands now, which can be
    * past `root`: a status taken from an older document would let an operation
    * write into text that no longer parses.
    */
   protected async captureAndSubmit(rootUri: string, root: TRoot): Promise<Action[]> {
      if (this.sharedServices.workspace.ModelLedger.versionOf(root) >= this.state.version) {
         this.state.setSourceRoot(rootUri, root);
      }
      const primary = this.currentPrimaryDocument();
      if (!primary) {
         // A primary deleted since the settle leaves nothing to be broken.
         this.state.setStatus(DiagramStatus.PARSE_ERROR, undefined);
      }
      const broken = primary ? this.refreshParseErrorStatus(primary) : [];

      // Skip the external submit until the initial requestModel completes; submitting too
      // early bumps root.revision and the client's stale first computedBounds is dropped,
      // leaving the canvas empty.
      if (this.submissionHandler.hasPendingInitialRequest()) {
         return [];
      }
      // While a document of the write set is structurally broken, keep the GModel the
      // client has, which the initial request has delivered by now, so the canvas
      // doesn't blank or lose its layout mid-typing. The parse-error status still
      // makes it read-only.
      if (broken.length > 0) {
         return [];
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
         return [];
      }
      return submitActions;
   }

   /**
    * Set {@link DiagramStatus.PARSE_ERROR} to {@link parseErrorStatus} while any
    * document the diagram writes is structurally broken, and withdraw it once
    * they all parse. Answers the documents that are broken.
    *
    * The secondaries count as much as the primary: an operation writes them from
    * the AST their parse recovered, which drops what the parser skipped, so a
    * write into a broken secondary overwrites the user's text.
    */
   protected refreshParseErrorStatus(primary: AstDocument<AstNode>): AstDocument<AstNode>[] {
      const broken = [primary, ...this.secondaryDocuments(primary.uri)].filter(document => this.isStructurallyBroken(document));
      this.state.setStatus(DiagramStatus.PARSE_ERROR, broken.length > 0 ? this.parseErrorStatus(broken) : undefined);
      return broken;
   }

   /** The write-set secondaries that exist, other than `primaryUri`. */
   protected secondaryDocuments(primaryUri: string): AstDocument<AstNode>[] {
      const { ModelService } = this.sharedServices.model;
      return this.state.secondaryUris
         .filter(uri => uri !== primaryUri)
         .map(uri => ModelService.getDocument(uri))
         .filter(document => document !== undefined)
         .map(document => this.sharedServices.workspace.AstDocumentManager.toAstDocument(document));
   }

   /**
    * Seam: is the AST structurally broken (lexing/parsing errors)? Drives both
    * the {@link DiagramStatus.PARSE_ERROR} status and the GModel resubmit
    * skip — keeping the last valid canvas instead of blanking it mid-typing.
    * Default: the lexer and parser errors of
    * the root's own parse, which exist from the parse on, so the answer does
    * not wait for validation; for a root its document has since replaced, any
    * error-severity diagnostic carrying a Langium `lexing-error` /
    * `parsing-error` code. Adopters override to compose additional break
    * reasons.
    */
   protected isStructurallyBroken(document: AstDocument<AstNode>): boolean {
      const parsed = document.root.$document?.parseResult;
      if (parsed?.value === document.root) {
         return hasStructuralErrors(parsed);
      }
      return document.diagnostics?.some(diagnostic => isStructuralDiagnostic(diagnostic)) ?? false;
   }

   /**
    * Seam: the {@link DiagramStatus.PARSE_ERROR} status while `brokenDocuments`
    * do not parse, the primary first when it is among them. Default: a read-only
    * error whose {@link DIAGRAM_READONLY_PARSE_ERROR} message names the first.
    *
    * A read-only status needs a message. Read-only withdraws the tool palette,
    * and without a message nothing on the canvas says why.
    */
   protected parseErrorStatus(brokenDocuments: AstDocument<AstNode>[]): DiagramStatusEntry {
      return {
         message: this.sharedServices.MessageRenderer.renderMessage(DIAGRAM_READONLY_PARSE_ERROR, {
            document: UriUtils.basename(URI.parse(brokenDocuments[0].uri))
         }),
         severity: 'ERROR',
         readonly: true
      };
   }

   /**
    * Seam: extra actions to dispatch right after the initial settled root is
    * captured (e.g. an adopter-specific status or palette refresh). Default: none.
    */
   protected onSourceModelSettled(_document: AstDocument<AstNode, never>): Action[] {
      return [];
   }

   /** The effective {@link SaveDeliveryPolicy}: the bound option, or {@link DEFAULT_SAVE_DELIVERY_POLICY} when unbound. */
   protected get saveDeliveryPolicy(): SaveDeliveryPolicy {
      return this.boundSaveDeliveryPolicy ?? DEFAULT_SAVE_DELIVERY_POLICY;
   }

   /**
    * Default save flow: persist the store's current text for every document the
    * diagram's session has open.
    *
    * **A save persists, it does not author.** Every diagram gesture already
    * reached the store through the diagram's session, so the store holds the
    * settled text and disk is the only thing behind. Re-serializing from the AST
    * here cannot improve on that text and can only damage it: a serializer
    * normalises formatting, and the comments the write path carries over keep
    * none of the hand-formatting around them, so a save would reflow a document
    * nothing changed — which is what a pure bounds drag does to the semantic
    * file when only its layout moved.
    *
    * **What is saved is the primary, every tracked secondary
    * (`AbstractHydraniumGlspState.trackSecondaryDocument`) and every document
    * that left the write set since the last save**, so a document the diagram
    * wrote is persisted whether or not it is the one the client named. One the
    * diagram's session does not have open is skipped, even when another client
    * has it open: that client's unsaved edits are not the diagram's to persist.
    *
    * **A save therefore names documents the gesture did not aim at**, which is
    * why an unchanged one is not rewritten even though the user asked for a
    * save: the mtime would move on a file they never touched. With the default
    * session, `AstDocumentManager.save` decides that per document and
    * announces the save either way.
    *
    * The configured {@link SaveDeliveryPolicy} (see {@link saveDeliveryPolicy})
    * decides await-vs-fire-and-forget and failure handling. The save persists
    * at `'any'`: the base-version guard exists to stop a stale writer
    * overwriting a newer document, and a flush persists the store — which
    * already holds every other client's change, including the one that
    * advanced the version.
    *
    * Returns `MaybePromise<void>` to match upstream `SourceModelStorage`:
    * resolves with the flush under `await`, returns synchronously under
    * `fire-and-forget`. To change how each document is written, override the
    * session class's `persistDocument`; an override of this method that writes
    * past the session skips that override.
    */
   saveSourceModel(action: SaveModelAction): MaybePromise<void> {
      // Normalised for the same reason the load path is: `SaveModelAction.fileUri`
      // is client-supplied on a "Save As" and carries whichever form that client
      // uses. The state fallback is already a URI string, and normalising one is
      // idempotent, so this only changes the client-supplied branch. Applied at
      // the call site rather than inside `getFileUri` so that method's contract —
      // return what the action said — is unchanged for adopters overriding it.
      const uri = this.toSourceModelUri(this.getFileUri(action));
      if (this.saveDeliveryPolicy.kind === 'fire-and-forget') {
         // Log rather than leave an unhandled rejection: the promise is not
         // returned, so nothing else will observe a failure. Named for the
         // diagram, since the document that failed may be a secondary.
         this.flushWriteSet(uri).catch(error =>
            this.logger.error(`Diagram save failed for ${uri}: ${error instanceof Error ? error.message : String(error)}`)
         );
         return undefined;
      }
      // Awaited: any failure propagates to GLSP's save-action handler, which
      // then sends no dirty state, so the one the save held back goes here.
      // An override that throws before it returns a promise throws inside the
      // async function too, so the hold always ends.
      this.ownSavesPending++;
      return (async () => {
         try {
            await this.flushWriteSet(uri);
         } catch (error: unknown) {
            this.sendDirtyState();
            throw error;
         } finally {
            this.ownSavesPending--;
         }
      })();
   }

   /**
    * Save the stored text of `primaryUri`, every tracked secondary and every
    * document that left the write set since the last save, each only where
    * the diagram's session has it open; then close those that left. Each goes
    * through the session's `persist`, so an override of the session class's
    * `persistDocument` applies to diagram saves too.
    *
    * Deduplicated, because a state that tracks its own primary as a secondary
    * would otherwise save it twice and fire two save notifications for one
    * save. Every save is called in one synchronous step, so each takes its text
    * before anything can close a document of the set: saved one after another,
    * a GLSP session ending during the first write closes the rest unsaved. A
    * `persistDocument` override that awaits before calling the base gives that
    * up, and a session ending during its await fails the rest with
    * `DocumentNotOpenError`.
    */
   protected async flushWriteSet(primaryUri: string): Promise<void> {
      // Refused like the load: without a session the client id's opens are
      // another participant's, and this would save them.
      const session = this.requireModelSession();
      const textDocuments = this.sharedServices.workspace.TextDocuments;
      const clientId = this.state.clientId;
      // Taken with the targets: a document leaving the set during the writes
      // was not saved by them, and stays open for the next save.
      const departed = [...this.departedSecondaries];
      const targets = [...new Set([primaryUri, ...this.state.secondaryUris, ...departed])].filter(uri =>
         textDocuments.isOpenInClient(uri, clientId)
      );
      // Async, so a persist that throws instead of rejecting fails its own
      // document rather than leaving the rest of the set uncalled. Settled in
      // full before failing, or the save's dirty-state hold ends while the
      // rest are still writing.
      const results = await Promise.allSettled(targets.map(async target => session.persist({ uri: target, baseVersion: 'any' })));
      const failures = results.flatMap((result, i) => (result.status === 'rejected' ? [{ uri: targets[i], reason: result.reason }] : []));
      if (failures.length > 0) {
         // Logged per document, since the save fails with the first alone and
         // its error need not name the document it came from.
         for (const { uri, reason } of failures) {
            this.logger.error(`Save failed for ${uri}: ${reason instanceof Error ? reason.message : String(reason)}`);
         }
         throw failures[0].reason;
      }
      for (const uri of departed) {
         if (this.departedSecondaries.delete(uri) && uri !== this.state.sourceUri) {
            try {
               await this.state.modelSession?.close(uri);
            } catch (error: unknown) {
               // A session that ended during the writes closed everything it
               // had open; refusing the close must not fail a save that wrote.
               // Caught around the call, since an ended session throws
               // before it returns a promise.
               if (!isSessionClosedError(error)) {
                  throw error;
               }
            }
         }
      }
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
    * Cancel any pending resubmit, drain every subscription — those registered
    * during {@link doLoadSourceModel} and the per-secondary ones, which live
    * outside {@link toDispose} because they come and go with the write set —
    * and end the diagram's client session with `cause`, closing everything it
    * has open. Idempotent.
    *
    * The session ends last, once the detach listener is gone: its closes would
    * otherwise report this storage's own teardown as a client detaching.
    */
   dispose(cause: SessionEndCause = 'closed'): void {
      this.resubmitDebouncer?.dispose();
      for (const subscription of this.secondarySubscriptions.values()) {
         subscription.dispose();
      }
      this.secondarySubscriptions.clear();
      this.toDispose.dispose();
      this.disposed = true;
      this.state.modelSession?.dispose(cause);
      this.state.modelSession = undefined;
   }
}
