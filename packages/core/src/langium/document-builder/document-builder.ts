/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type LogThreshold, type MaybeObservableValue, ObservableValue, type Tracer } from '@hydranium/protocol';
import {
   type BuildOptions,
   DefaultDocumentBuilder,
   type DocumentPhaseListener,
   DocumentState,
   type LangiumDocument,
   OperationCancelled,
   type URI,
   UriUtils,
   interruptAndCheck,
   isOperationCancelled
} from '@hydranium/langium';
import { CancellationToken, type Diagnostic } from 'vscode-languageserver-protocol';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { CST_REHYDRATION_RESET_STATE, isCstShed } from '../residency/cst-residency-service.js';
import { type ExtendedServiceRegistry } from '../service-registry.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { type DocumentUriPolicy } from '../workspace/document-uri-policy.js';
import { type LabeledPhaseListener, labelPhaseListener } from './labeled-phase-listener.js';

/** Document states a phase-reached line is emitted for by default — every built phase. */
export const DEFAULT_LOGGED_PHASES: DocumentState[] = [
   DocumentState.Parsed,
   DocumentState.IndexedContent,
   DocumentState.ComputedScopes,
   DocumentState.Linked,
   DocumentState.IndexedReferences,
   DocumentState.Validated
];

/**
 * Consecutive re-queued builds that leave a waited-on document at the same state
 * before {@link HydraniumDocumentBuilder.awaitDocumentState} stops re-queuing it.
 * A backstop against spinning builds for a document the builder will never carry
 * to the requested state, not a tuning knob — the first re-queue resolves the
 * case this exists for.
 */
const MAX_STALLED_REQUEUES = 3;

/** Constructor options for {@link HydraniumDocumentBuilder}. */
export interface DocumentBuilderOptions extends LogNameOptions {
   /**
    * Level at which framework-side log lines are emitted, or `'off'` to
    * suppress every framework log line entirely. Default: `'debug'`. Read once
    * at construction to gate phase-listener registration, so it is a plain
    * value — a live change could not register or dispose listeners.
    */
   readonly logLevel?: LogThreshold;
   /**
    * Document states for which a phase-reached line is emitted. Default: every
    * built phase. Read once at construction (it drives listener registration),
    * so it is a plain value.
    */
   readonly loggedPhases?: DocumentState[];
   /**
    * `notifyDocumentPhase` total ms at or above which a per-listener breakdown
    * is logged. Default: `25`. Read per phase, so it accepts a
    * {@link MaybeObservableValue} — pass a constant or bind it to a user setting.
    */
   readonly slowPhaseMs?: MaybeObservableValue<number>;
   /**
    * Per-listener ms at or above which a listener appears in the breakdown.
    * Default: `5`. Read per phase; accepts a {@link MaybeObservableValue}.
    */
   readonly slowListenerMs?: MaybeObservableValue<number>;
   /**
    * `notifyBuildPhase` total ms at or above which the listener-count line is
    * logged. Default: `25`. Read per phase; accepts a {@link MaybeObservableValue}.
    */
   readonly slowBuildMs?: MaybeObservableValue<number>;
   /**
    * Refresh cross-document `ComputedScopes` derivations when a referencing
    * document is cascade-rebuilt (see
    * {@link HydraniumDocumentBuilder.resetToState}). An `AstExtension` at
    * `ComputedScopes` that reads a cross-document reference and caches a
    * projection of the target keeps a STALE projection otherwise. Default
    * `false` (Langium's standard reset — no extra work). Adopters whose
    * `ComputedScopes` extensions derive from other documents set `true`, at the
    * cost of one extra `collectLocalSymbols` per cascade-affected document.
    */
   readonly refreshCrossDocumentComputedScopes?: boolean;
}

/**
 * Extends Langium's {@link DefaultDocumentBuilder} with:
 *
 * - **Bug-fixes** (always on): an {@link awaitDocumentState} that waits where
 *   the default rejects, a {@link prepareBuild} that keeps a cancelled
 *   non-validating build from suppressing validation, and a
 *   {@link shouldRelink} that never judges a document unaffected on an index
 *   that does not describe it.
 * - **URI handling** (always on): directory-aware flattening and cascade
 *   deletes in {@link update}, plus the CST-rehydration and cross-document
 *   refresh resets in {@link resetToState}.
 * - **In-place rebuild helpers** — {@link reparse} and
 *   {@link reparseAndRelink} — for a build-phase listener that mutated a
 *   document's AST and must reconcile it within the same build.
 * - **Diagnostic dedupe** at `Validated` ({@link dedupeDiagnostics}).
 * - **Logging instrumentation** (default on, opt-out via `logLevel: 'off'`):
 *   phase-reached lines, slow-listener breakdowns on `notifyDocumentPhase`,
 *   and slow-build-phase totals on `notifyBuildPhase`.
 *
 * Adopters extend this class — the configuration knobs cover what most
 * adopters need; the `format*Line` methods, `formatUri`, and
 * `collectDeletedURIs` are protected so subclasses can customise wording or
 * domain-aware cascades without re-implementing surrounding logic.
 */
export class HydraniumDocumentBuilder extends DefaultDocumentBuilder {
   protected readonly tracer: Tracer;
   /** Plain — read once at construction to gate phase-listener registration. */
   protected readonly logLevel: LogThreshold;
   /** Plain — read once at construction; drives which phases get a listener. */
   protected readonly loggedPhases: DocumentState[];
   /** Live slow-phase-total threshold; read `.value` per phase. */
   protected readonly slowPhaseMs: ObservableValue<number>;
   /** Live per-listener threshold; read `.value` per phase. */
   protected readonly slowListenerMs: ObservableValue<number>;
   /** Live slow-build-phase-total threshold; read `.value` per phase. */
   protected readonly slowBuildMs: ObservableValue<number>;
   protected readonly uriPolicy: DocumentUriPolicy;
   protected readonly clock: Clock;
   /** Narrower handle on the same registry as the inherited `serviceRegistry`, for {@link ExtendedServiceRegistry.registrations}. */
   protected readonly languageRegistry: ExtendedServiceRegistry;
   protected languageFileExtensions: string[] = [];
   /** {@link ExtendedServiceRegistry.registrations} {@link languageFileExtensions} was built at; `-1` until first built. */
   protected cachedRegistrations = -1;
   protected lastPhaseMs = 0;
   /** Resolved from {@link DocumentBuilderOptions.refreshCrossDocumentComputedScopes}. */
   protected readonly refreshCrossDocumentComputedScopes: boolean;
   /** LSP event name (e.g. `'didChangeWatchedFiles'`) staged for the next `update()` call. */
   protected pendingUpdateReason?: string;

   constructor(services: ServerSharedServicesMinimal, options: DocumentBuilderOptions = {}) {
      super(services);
      this.languageRegistry = services.ServiceRegistry;
      this.uriPolicy = services.workspace.DocumentUriPolicy;
      this.clock = services.Clock;
      this.tracer = services.Tracer.for(options.logName ?? 'DocumentBuilder').trace('instantiated');
      this.logLevel = options.logLevel ?? 'debug';
      this.loggedPhases = options.loggedPhases ?? DEFAULT_LOGGED_PHASES;
      this.slowPhaseMs = ObservableValue.from(options.slowPhaseMs ?? 25);
      this.slowListenerMs = ObservableValue.from(options.slowListenerMs ?? 5);
      this.slowBuildMs = ObservableValue.from(options.slowBuildMs ?? 25);
      this.refreshCrossDocumentComputedScopes = options.refreshCrossDocumentComputedScopes ?? false;
      if (this.logLevel !== 'off') {
         this.registerPhaseListeners();
      }
   }

   // ============================================================
   // Public API — observability primitives
   // ============================================================

   /**
    * Stage an LSP event name for the next `update()` call. Adopters call before
    * the update fires; `HydraniumDocumentUpdateHandler` does it for the
    * four LSP events.
    *
    * The framework stages the value and never reads it back. The consumer is a
    * subclass overriding the build logging, which takes
    * {@link pendingUpdateReason}, clears it, and tags its build line with the
    * event that caused the build. So a grep of this repo alone shows a write
    * with no read — that is the seam working, not a dead field.
    */
   markNextReason(reason: string | undefined): void {
      this.pendingUpdateReason = reason;
   }

   /**
    * Diagnostic snapshot for use in timeout/error messages around document
    * state.
    *
    * Public rather than `protected`, against the default for a `format*`
    * helper: the GLSP head reads it off the shared services tree to build its
    * own diagnostics, and a cross-package caller cannot reach a `protected`
    * member. Narrowing it would move that formatting into the caller and
    * duplicate what this already knows.
    */
   formatBuildStatus(uri: URI): string {
      // Canonicalize at the door (like every other document-lookup): a caller may
      // hold a divergent spelling (e.g. a GLSP state's symlink `_sourceUri`) while
      // the document is keyed by its real path.
      const doc = this.langiumDocuments.getDocument(UriUtils.toUri(this.uriPolicy.canonicalUri(uri)));
      const docState = doc ? DocumentState[doc.state] : 'unknown (document not loaded)';
      const lastPhase = this.lastPhaseMs > 0 ? `${Math.round(performance.now() - this.lastPhaseMs)}ms ago` : 'no phase observed';
      return `current state: '${docState}', last phase: ${lastPhase}`;
   }

   // ============================================================
   // Bug-fixes (always on)
   // ============================================================

   /**
    * Two edge cases the default Langium implementation rejects on:
    * - Document below target state with no build active (newly-created file):
    *   wait for the next build instead of rejecting with "workspace state
    *   already Validated".
    * - Document at target state but build active and state may regress: wait
    *   for phase notification instead of resolving immediately on stale state.
    *
    * When the document is already at target state and no regression is in
    * progress, resolves immediately — avoids deadlocks where callers inside
    * `onDocumentPhase` callbacks would block the active build otherwise.
    *
    * Replacing Langium's rejection with a wait makes the wait's liveness this
    * class's responsibility: a listener can only fire if some build is still
    * going to reach `state`. Both re-queue sites below exist for that, and they
    * differ only in when the orphaning is observed — {@link isOrphaned} at
    * registration time, the `onBuildPhase` branch for a build cancelled after
    * the wait was already armed. Re-queuing stops after
    * {@link MAX_STALLED_REQUEUES} builds that fail to advance the document, so a
    * document the builder will never carry to `state` degrades to a pending wait
    * plus a warning rather than an endless build loop.
    */
   protected override awaitDocumentState(state: DocumentState, uri: URI, cancelToken: CancellationToken): Promise<URI> {
      const document = this.langiumDocuments.getDocument(uri);
      if (!document) {
         return super.awaitDocumentState(state, uri, cancelToken);
      }
      if (document.state >= state) {
         return Promise.resolve(uri);
      }
      return new Promise<URI>((resolve, reject) => {
         // Re-queues since the document last advanced. A re-queue is only ever
         // worth repeating if the previous one made progress: repeating it for a
         // document the builder will never carry to `state` — an adopter
         // narrowing `shouldValidate`, say — would spin builds forever, since
         // each build's own completion is what re-triggers the branch below.
         // Bounded rather than one-shot because a re-queue legitimately fails to
         // land while a busy workspace keeps cancelling builds.
         let stalledRequeues = 0;
         let lastRequeueState: DocumentState | undefined;
         const requeue = (reason: string): void => {
            if (document.state === lastRequeueState) {
               if (++stalledRequeues > MAX_STALLED_REQUEUES) {
                  this.tracer
                     .withUri(uri.toString())
                     .warn(
                        `Giving up re-queuing ${this.formatUri(uri)}: stuck at '${DocumentState[document.state]}', needs ` +
                           `'${DocumentState[state]}' after ${stalledRequeues} builds that did not advance it. ` +
                           'The wait now depends on its cancellation token.'
                     );
                  return;
               }
            } else {
               stalledRequeues = 0;
               lastRequeueState = document.state;
            }
            this.requeueOrphaned(document, state, reason);
         };
         const phaseDisposable = this.onDocumentPhase(
            state,
            labelPhaseListener((doc: LangiumDocument): void => {
               if (UriUtils.equals(doc.uri, uri)) {
                  cleanup();
                  resolve(doc.uri);
               }
            }, 'awaitDocumentState')
         );
         const buildDisposable = this.onBuildPhase(DocumentState.Validated, () => {
            if (document.state >= state) {
               cleanup();
               resolve(uri);
            } else {
               // Orphaned by a cancelled build — re-queue so the next build catches it up.
               requeue('cancelled build');
            }
         });
         const cancelDisposable = cancelToken.onCancellationRequested(() => {
            cleanup();
            reject(OperationCancelled);
         });
         const cleanup = (): void => {
            phaseDisposable.dispose();
            buildDisposable.dispose();
            cancelDisposable.dispose();
         };
         // Orphaned BEFORE the wait was armed: the build that would have
         // advanced this document has already finished, so neither listener
         // above can ever fire. Re-queue now — the listeners are registered, so
         // the resulting build resolves this wait.
         if (this.isOrphaned(document, state)) {
            requeue('quiescent builder');
         }
      });
   }

   /**
    * Whether no build will advance `document` to `state`, so a wait on it can
    * only be resolved by starting one.
    *
    * `currentState` is the target phase the builder last *completed*, and both
    * `build` and `update` reset it to `Changed` before stepping the phases — so
    * `currentState >= state` means the workspace has already passed `state`
    * without carrying this document along, rather than being on its way there.
    * That is precisely the condition Langium's `awaitDocumentState` rejects on;
    * this class waits instead, and therefore has to schedule the build itself.
    *
    * The common cause is benign: workspace initialization builds with Langium's
    * default `initialBuildOptions`, whose `validation` is unset, which
    * leaves every document at `IndexedReferences` while the builder's own
    * `currentState` still advances to `Validated` (the validation phase runs
    * over an empty document list). Any first read that wants diagnostics — a
    * one-shot data-head read, a CLI query, `ModelService.validated` — lands
    * here.
    */
   protected isOrphaned(document: LangiumDocument, state: DocumentState): boolean {
      return document.state < state && this.currentState >= state;
   }

   /**
    * Schedule a build for a document no in-flight build will advance. Deliberately
    * fire-and-forget: the caller is a waiter that resolves off the resulting phase
    * notification, so awaiting here would invert the dependency. A rejection is
    * logged rather than swallowed — it leaves the waiter pending until its own
    * cancellation token fires, which is worth a line in the log.
    */
   protected requeueOrphaned(document: LangiumDocument, state: DocumentState, reason: string): void {
      const tracer = this.tracer.withUri(document.uri.toString());
      tracer.info(`Re-queuing orphaned document (at '${DocumentState[document.state]}', needs '${DocumentState[state]}'): ${reason}`);
      this.update([document.uri], []).catch((err: unknown) => {
         if (!isOperationCancelled(err)) {
            tracer.error(`Re-queue build failed: ${err instanceof Error ? err.message : String(err)}`);
         }
      });
   }

   /**
    * Don't let a cancelled non-validating build suppress validation forever.
    *
    * Langium's `prepareBuild` deliberately RETAINS the previous build options
    * for a document whose previous build did not complete, so a cancelled
    * build resumes with the options it started under. That is right in
    * general and wrong for exactly one case: the initial workspace build runs
    * with `initialBuildOptions` (`{}` — validation OFF), so if it is cancelled
    * partway, every document it had not yet finished keeps `validation: false`.
    * The next build inherits that, `shouldValidate` returns false, and
    * `buildDocuments` marks those documents COMPLETED without ever validating
    * them — no diagnostics computed, none published, and nothing in the log.
    *
    * A write arriving during workspace startup is enough to trigger it, since
    * `WorkspaceLock.write` cancels the in-flight initial build. Measured: the
    * cross-grammar dependents of an edited document silently never publish.
    *
    * So when the incoming build asks for validation and a retained, incomplete
    * state does not, upgrade that state's validation option. Resuming
    * behaviour is otherwise untouched — the retained state, its phase and its
    * prior result all still stand.
    */
   protected override prepareBuild(documents: LangiumDocument[], options: BuildOptions): void {
      super.prepareBuild(documents, options);
      if (!options.validation) {
         return;
      }
      for (const document of documents) {
         const key = document.uri.toString();
         const state = this.buildState.get(key);
         if (state && !state.completed && !state.options.validation) {
            this.buildState.set(key, { ...state, options: { ...state.options, validation: options.validation } });
            this.tracer.withUri(key).debug('Upgraded a retained incomplete build state to validate (was carrying validation:false)');
         }
      }
   }

   /**
    * Never judge a document unaffected on an index that does not describe it.
    *
    * Langium's `shouldRelink` asks `IndexManager.isAffected`, which reads the
    * REFERENCE index — populated at `DocumentState.IndexedReferences`. A
    * document that has not reached that phase has no entries there, so
    * `isAffected` returns false for every change: not "unaffected", merely
    * unknown. It is then left at `Linked`, and because `runCancelable` only
    * processes documents whose state is BELOW its target, the next build does
    * not re-link it either — it advances to `Validated` carrying links resolved
    * against the OLD content, and validates clean.
    *
    * An interrupted initial build is enough to produce that state: the workspace
    * build is a `WorkspaceLock.write` action, so any write arriving during
    * startup cancels it, typically between `Linked` and `IndexedReferences`.
    * Measured: the edited document's cross-grammar dependents keep stale,
    * successfully-resolved references and report no diagnostics at all.
    *
    * Treating an un-indexed document as affected is the conservative reading and
    * costs nothing in steady state — documents sit at `Validated` there, so this
    * branch is only taken for documents an interrupted build left behind.
    */
   protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
      if (document.state < DocumentState.IndexedReferences) {
         return true;
      }
      return super.shouldRelink(document, changedUris);
   }

   // ============================================================
   // URI handling — directory flattening + cascade deletes (always on)
   // ============================================================

   override update(changed: URI[], deleted: URI[], cancelToken?: CancellationToken): Promise<void> {
      this.ensureLanguageFileExtensions();
      const changedURIs = changed.flatMap(uri => this.flattenAndAdaptURI(uri));
      const deletedURIs = deleted.flatMap(uri => this.collectDeletedURIs(uri));
      return super.update(changedURIs, deletedURIs, cancelToken);
   }

   /**
    * Refresh cross-document `ComputedScopes` derivations on cascade, when
    * {@link refreshCrossDocumentComputedScopes} is set (default off).
    *
    * An `AstExtension` registered at `ComputedScopes` whose `compute` resolves
    * a cross-document reference and reads the target's data depends on another
    * document's content. Langium resets a
    * cascade-affected (referencing) document TO `ComputedScopes` and rebuilds it
    * from `Linked` — so the `ComputedScopes` phase is never re-emitted for it and
    * those derivations keep a stale projection of the referenced document. The
    * symptom: a document whose computed projection of the referenced document
    * — the projection that feeds its scope during `Linked` — does not pick up a
    * member added there until the referencing document is re-parsed.
    *
    * When enabled, reset such documents one phase lower, to `IndexedContent`, so `ComputedScopes`
    * (and its AST-extension pass) re-executes before the document's own link.
    * `IndexedContent` — not `Parsed` — is the minimal reset: the document is left
    * AT `IndexedContent`, so the build's `IndexedContent` pass skips it (no
    * redundant own-symbol re-index) while the `ComputedScopes` pass re-runs
    * `collectLocalSymbols` + the extension refresh. `ComputedScopes` is passed here
    * only for the relink set (changed documents reset to `Changed`,
    * supersession resets to `IndexedReferences`), so this is scoped to exactly the
    * cascade-affected documents. Cost: one extra `collectLocalSymbols` per affected
    * document per cascade.
    */
   override resetToState(document: LangiumDocument, state: DocumentState): void {
      // Rehydrate-on-re-entry after CST shedding. A document whose CST was shed to
      // reclaim memory (its `parseResult.value.$cstNode` nulled while the AST stays
      // resident) cannot be relinked or re-indexed in place: Langium's
      // `DefaultReferenceDescriptionProvider` derives the reference index — and thus
      // `IndexManager.isAffected`, plus the `segment` used by rename / find-references —
      // from each `reference.$refNode`. Re-running `IndexedReferences` with a shed CST
      // drops the document's cross-references from the index (the provider skips any
      // reference whose `$refNode` is missing), so its dependents silently stop being
      // relinked when a referenced document changes, and they keep stale `.ref`s.
      //
      // So any re-entry into the build for a shed document must start from a full
      // re-parse, which rebuilds the CST (and every `$refNode`). The residency
      // feature owns both the "is shed" predicate and the recovery reset state
      // (`CST_REHYDRATION_RESET_STATE`, necessarily `Changed`); this
      // supersedes the `IndexedContent` cascade reset below — a re-parse re-runs
      // every phase regardless.
      if (isCstShed(document)) {
         this.tracer.debug(`rehydrating CST of ${this.formatUri(document.uri)} (re-entered build while shed)`);
         super.resetToState(document, CST_REHYDRATION_RESET_STATE);
         return;
      }
      const targetState =
         this.refreshCrossDocumentComputedScopes && state === DocumentState.ComputedScopes ? DocumentState.IndexedContent : state;
      super.resetToState(document, targetState);
   }

   /**
    * Re-parse a single document in place from its *current text* (the synced
    * store, else disk), advancing it to `Parsed`. A thin wrapper over Langium's
    * document factory so a caller already holding the write lock — e.g. the
    * integrity service, which updated the document text after mutating its AST —
    * can re-derive a fresh, consistent CST/AST without a full `update()` cycle.
    *
    * Reads the canonical source the build itself parses (not a passed-in
    * string), so the CST cannot drift from the synced text; callers must update
    * the text before calling.
    */
   async reparse(document: LangiumDocument, cancelToken: CancellationToken = CancellationToken.None): Promise<void> {
      await this.langiumDocumentFactory.update(document, cancelToken);
   }

   /**
    * Re-run the parse → index-content → local-scopes → link phases (0–3) for a
    * single already-built document, in place — re-firing the per-document phase
    * notifications (`onDocumentPhase`, e.g. AST-extension refresh) but NOT the
    * batch `onBuildPhase` notifications.
    *
    * For a build-phase listener (e.g. the integrity service) that mutated a
    * document's AST *after* it was linked — and updated its text to match — and
    * must reconcile the document within the SAME build. A bare AST mutation
    * leaves the CST stale, which makes Langium's re-parse gate
    * (`DefaultLangiumDocumentFactory.update`, keyed on the CST's `fullText`)
    * skip the re-parse on a later build and strand the mutated AST (a corrected
    * edge never returns on reopen). Re-running the document through
    * {@link buildDocuments} would re-fire `onBuildPhase` and re-enter the
    * listener (recursion), so this mirrors {@link runCancelable}'s per-document
    * progression (op → set state → `notifyDocumentPhase`) for phases 0–3 while
    * deliberately omitting `notifyBuildPhase`.
    *
    * Re-firing `onDocumentPhase` matters: per-document derivations such as
    * AST-extension computed properties are wired there, and the freshly
    * re-parsed AST would otherwise lack them. The caller
    * runs inside the `Linked` build phase; the build carries the document
    * through IndexedReferences + Validation (and their `onDocumentPhase`) next.
    */
   async reparseAndRelink(document: LangiumDocument, cancelToken: CancellationToken = CancellationToken.None): Promise<void> {
      const languageServices = this.serviceRegistry.getServices(document.uri);
      // Phase 0 — Parse (the factory sets state to `Parsed` itself).
      await this.reparse(document, cancelToken);
      await this.notifyDocumentPhase(document, DocumentState.Parsed, cancelToken);
      // Phase 1 — Index content.
      await this.indexManager.updateContent(document, cancelToken);
      document.state = DocumentState.IndexedContent;
      await this.notifyDocumentPhase(document, DocumentState.IndexedContent, cancelToken);
      // Phase 2 — Local scopes.
      document.localSymbols = await languageServices.references.ScopeComputation.collectLocalSymbols(document, cancelToken);
      document.state = DocumentState.ComputedScopes;
      await this.notifyDocumentPhase(document, DocumentState.ComputedScopes, cancelToken);
      // Phase 3 — Linking.
      await languageServices.references.Linker.link(document, cancelToken);
      document.state = DocumentState.Linked;
      await this.notifyDocumentPhase(document, DocumentState.Linked, cancelToken);
   }

   /**
    * Cached on first access — language registration completes after
    * construction — and refreshed on every registration since.
    *
    * The refresh matters because the cache is otherwise held for the process
    * lifetime: a language registered after the first directory expansion would
    * be silently excluded from it, so files of that language would never build
    * on a watched-directory change.
    *
    * Keyed on the registry's monotonic `registrations` counter, not on
    * `all.length`: `register` writes into a map keyed by language id, so
    * REPLACING a registered id leaves the length unchanged and a
    * count-keyed cache would keep the replaced language's extensions. One
    * integer comparison per call, and the "registration must be finished
    * before the first expansion" precondition is gone rather than narrowed.
    */
   protected ensureLanguageFileExtensions(): void {
      const registrations = this.languageRegistry.registrations;
      if (this.cachedRegistrations !== registrations) {
         this.languageFileExtensions = this.languageRegistry.all.flatMap(service => service.LanguageMetaData.fileExtensions);
         this.cachedRegistrations = registrations;
      }
   }

   /**
    * Expand a changed URI to the registered-language files it covers, keyed
    * canonically. A file resolves to itself (when its extension is registered);
    * a directory expands to every registered language file beneath it.
    *
    * The expansion goes through the `FileSystemProvider` so it is
    * platform-agnostic and discovers on-disk files that are *not yet loaded as
    * documents*: the Node provider walks the real filesystem (a freshly added
    * directory or never-opened file still builds), while a browser / empty
    * provider yields nothing. `uriPolicy.loadUri` first maps the URI to its
    * load identity — `undefined` (no on-disk content) short-circuits to `[]`
    * rather than a doomed read, and a symlink resolves to its real path so the
    * built documents key the same way every other layer does.
    */
   protected flattenAndAdaptURI(uri: URI): URI[] {
      const resolved = this.uriPolicy.loadUri(uri);
      return resolved ? this.collectLanguageFiles(resolved) : [];
   }

   /** Recurse `uri` through the `FileSystemProvider`, gathering registered
    *  language files. A directory's entries carry their own `isDirectory`, so
    *  the walk stats each node once (via `readDirectorySync`). */
   protected collectLanguageFiles(uri: URI): URI[] {
      if (!this.isDirectory(uri)) {
         return this.isLanguageFile(uri) ? [uri] : [];
      }
      return this.fileSystemProvider.readDirectorySync(uri).flatMap(entry => {
         if (entry.isDirectory) {
            return this.collectLanguageFiles(entry.uri);
         }
         return this.isLanguageFile(entry.uri) ? [entry.uri] : [];
      });
   }

   /** A path the provider cannot stat as a directory (missing / unreadable / a
    *  plain file) is treated as a non-directory; `collectLanguageFiles` then
    *  filters it by extension. */
   protected isDirectory(uri: URI): boolean {
      try {
         return this.fileSystemProvider.statSync(uri).isDirectory;
      } catch {
         return false;
      }
   }

   /** True when `uri`'s extension matches one of the registered language extensions. */
   protected isLanguageFile(uri: URI): boolean {
      return this.languageFileExtensions.includes(UriUtils.extname(uri));
   }

   /**
    * Collect URIs to delete when `uri` is deleted. Default: if `uri` is a
    * file, return `[uri]`; if it's a directory, return all documents under
    * that path. Override for domain-aware cascades (e.g. when deleting a
    * project descriptor should cascade to all its members).
    */
   protected collectDeletedURIs(uri: URI): URI[] {
      if (UriUtils.extname(uri)) {
         return [uri];
      }
      return [
         ...this.langiumDocuments.all
            .filter(doc => UriUtils.contains(uri, doc.uri))
            .map(doc => doc.uri)
            .toArray(),
         uri
      ];
   }

   // ============================================================
   // Logging — phase-reached listeners
   // ============================================================

   protected registerPhaseListeners(): void {
      for (const state of this.loggedPhases) {
         this.onBuildPhase(state, documents => this.onPhaseReached(state, documents));
      }
   }

   /** Called once per phase-reached event. Override to add custom side-effects beyond logging. */
   protected onPhaseReached(state: DocumentState, documents: LangiumDocument[]): void {
      const now = performance.now();
      const elapsedMs = Math.round(now - this.lastPhaseMs);
      this.lastPhaseMs = now;
      this.log(this.phaseReachedLine(state, documents, elapsedMs));
   }

   /** Format the phase-reached log line. Override to customise wording. */
   protected phaseReachedLine(state: DocumentState, documents: LangiumDocument[], elapsedMs: number): string {
      const docInfo = documents.length === 1 ? this.formatUri(documents[0].uri) : `${documents.length} docs`;
      return `Reached phase '${DocumentState[state]}' [${docInfo}, ${elapsedMs}ms since previous phase]`;
   }

   // ============================================================
   // Logging — slow-listener breakdown on notifyDocumentPhase
   // ============================================================

   override async notifyDocumentPhase(document: LangiumDocument, state: DocumentState, cancelToken: CancellationToken): Promise<void> {
      // Before the listeners, one of which is Langium's diagnostics publisher.
      // Running first is NOT the same as running atomically with them: the loop
      // below awaits, Langium's validate PUSHES onto the live array rather than
      // replacing it, and the publisher reads that array when it is invoked. A
      // build settling inside that window therefore appends after this call has
      // already deduped, and the appended duplicate is published by the listener
      // of the build that deduped. Only `serializeBuilds` closes the window.
      if (state === DocumentState.Validated) {
         this.dedupeDiagnostics(document);
      }
      if (this.logLevel === 'off') {
         return super.notifyDocumentPhase(document, state, cancelToken);
      }
      const listeners = this.documentPhaseListeners.get(state).slice();
      if (listeners.length === 0) {
         return;
      }
      const perListenerMs: number[] = [];
      let cancelledListeners = 0;
      const { elapsedMs: totalMs } = await this.clock.measure(async () => {
         for (const listener of listeners) {
            const { elapsedMs } = await this.clock.measure(async () => {
               try {
                  await interruptAndCheck(cancelToken);
                  await listener(document, cancelToken);
               } catch (err) {
                  if (!isOperationCancelled(err)) {
                     throw err;
                  }
                  cancelledListeners++;
               }
            });
            perListenerMs.push(elapsedMs);
         }
      });
      if (cancelledListeners > 0) {
         this.tracer
            .withUri(document.uri.toString())
            .info(this.cancelledDocumentPhaseLine(document, state, cancelledListeners, listeners.length));
      }
      if (totalMs >= this.slowPhaseMs.value) {
         this.log(this.slowDocumentPhaseLine(document, state, listeners, perListenerMs, totalMs));
      }
   }

   /**
    * Format the skipped-listener line.
    *
    * Worth `info` rather than `debug` because of what the skip costs: Langium's
    * `runCancelable` assigns `document.state = targetState` BEFORE calling
    * `notifyDocumentPhase`, so a token that cancels here leaves the document AT
    * the phase with its listeners never run — and the next build's
    * `document.state < targetState` guard then skips it, so nothing re-notifies.
    * At `DocumentState.Validated` the skipped listener is Langium's diagnostics
    * publisher, so the client silently never receives those diagnostics.
    */
   protected cancelledDocumentPhaseLine(document: LangiumDocument, state: DocumentState, cancelled: number, total: number): string {
      return (
         `notifyDocumentPhase '${DocumentState[state]}' [${this.formatUri(document.uri)}]: ` +
         `${cancelled} of ${total} listeners skipped by cancellation — the document is AT this phase but they did not run`
      );
   }

   /** Format the slow-listener breakdown line. Override to customise wording. */
   protected slowDocumentPhaseLine(
      document: LangiumDocument,
      state: DocumentState,
      listeners: DocumentPhaseListener[],
      perListenerMs: number[],
      totalMs: number
   ): string {
      const slow = perListenerMs
         .map((ms, i) => ({ ms, i }))
         .filter(x => x.ms >= this.slowListenerMs.value)
         .sort((a, b) => b.ms - a.ms)
         .map(x => `${this.formatListener(listeners[x.i], x.i)}:${x.ms.toFixed(0)}ms`);
      const breakdown = slow.length > 0 ? ` — slow listeners: [${slow.join(', ')}]` : '';
      return `notifyDocumentPhase '${DocumentState[state]}' [${this.formatUri(document.uri)}]: ${listeners.length} listeners in ${totalMs.toFixed(0)}ms${breakdown}`;
   }

   // ============================================================
   // Logging — slow build-phase total on notifyBuildPhase
   // ============================================================

   override async notifyBuildPhase(documents: LangiumDocument[], state: DocumentState, cancelToken: CancellationToken): Promise<void> {
      if (this.logLevel === 'off') {
         return super.notifyBuildPhase(documents, state, cancelToken);
      }
      const listeners = this.buildPhaseListeners.get(state);
      if (documents.length === 0 || listeners.length === 0) {
         return super.notifyBuildPhase(documents, state, cancelToken);
      }
      const { elapsedMs: totalMs } = await this.clock.measure(() => super.notifyBuildPhase(documents, state, cancelToken));
      if (totalMs >= this.slowBuildMs.value) {
         this.log(this.slowBuildPhaseLine(state, listeners.length, documents, totalMs));
      }
   }

   /** Format the slow build-phase line. Override to customise wording. */
   protected slowBuildPhaseLine(state: DocumentState, listenerCount: number, documents: LangiumDocument[], totalMs: number): string {
      return `notifyBuildPhase '${DocumentState[state]}': ${listenerCount} listeners, ${documents.length} docs in ${totalMs.toFixed(0)}ms`;
   }

   // ============================================================
   // Shared formatting hooks
   // ============================================================

   /** Format a URI for inclusion in log lines. Default: `uri.toString()`. Override for workspace-relative paths. */
   protected formatUri(uri: URI): string {
      return uri.toString();
   }

   /** Get a human-readable identifier for a phase listener. Falls back to `function.name` or `#index`. */
   protected formatListener(listener: DocumentPhaseListener, index: number): string {
      const labeled = listener as DocumentPhaseListener & LabeledPhaseListener;
      return labeled.displayName ?? (listener.name && listener.name !== 'anonymous' ? listener.name : `#${index}`);
   }

   /**
    * Collapse byte-identical duplicate diagnostics on `document`, in place.
    *
    * Two unserialised validation passes over one document report everything
    * twice: Langium's validate appends to `document.diagnostics` when they are
    * already set — deliberately, so a category-partitioned pass keeps the earlier
    * category's findings — and a repeated FULL pass therefore doubles the list.
    * `ModelServiceOptions.serializeBuilds` prevents that at the source; this is
    * the net for configurations that allow concurrent builds anyway.
    *
    * Clearing the list before a pass is NOT an alternative: the append happens at
    * pass completion, so two interleaved passes both clear, both finish, and the
    * second still appends onto the first.
    *
    * **Equality is structural over the WHOLE diagnostic**, not a chosen subset of
    * fields. That matters: `Diagnostic` carries `data` (which drives quick fixes),
    * `relatedInformation`, `tags` and `source` besides the obvious range/message,
    * so keying on a subset could collapse two findings that differ only in a
    * code action. Duplicates produced by re-running the same checks over the same
    * AST are identical in every field, so full structural equality removes
    * exactly those. The one behavioural difference from a single pass: if a
    * single pass ever emitted two byte-identical diagnostics, the count drops to
    * one — indistinguishable to any consumer, since nothing can tell the two
    * apart.
    *
    * Cost is kept off the common path. Each diagnostic contributes one short
    * range key; a diagnostic is serialised ONLY when something else already
    * occupies its range, so a document whose diagnostics are all at distinct
    * ranges — every document, whenever builds are serialised — is walked without
    * serialising anything.
    */
   protected dedupeDiagnostics(document: LangiumDocument): void {
      const diagnostics = document.diagnostics;
      if (!diagnostics || diagnostics.length < 2) {
         return;
      }
      const byRange = new Map<string, Diagnostic[]>();
      const unique: Diagnostic[] = [];
      for (const diagnostic of diagnostics) {
         const { start, end } = diagnostic.range;
         const range = `${start.line}:${start.character}-${end.line}:${end.character}`;
         const bucket = byRange.get(range);
         if (!bucket) {
            // First at this range: no candidate to compare against, so no
            // serialisation. This is the whole list when nothing is duplicated,
            // which is the default configuration's every call.
            byRange.set(range, [diagnostic]);
            unique.push(diagnostic);
            continue;
         }
         // Same range as something already kept — now it is worth comparing, and
         // the comparison is over the WHOLE diagnostic so two findings differing
         // only in `data` (a quick-fix payload) or `relatedInformation` survive.
         const serialised = JSON.stringify(diagnostic);
         if (bucket.some(kept => JSON.stringify(kept) === serialised)) {
            continue;
         }
         bucket.push(diagnostic);
         unique.push(diagnostic);
      }
      if (unique.length !== diagnostics.length) {
         this.tracer.debug(`collapsed ${diagnostics.length - unique.length} duplicate diagnostic(s) on ${this.formatUri(document.uri)}`);
         document.diagnostics = unique;
      }
   }

   // ============================================================
   // Internal helpers
   // ============================================================

   /** Dispatch a log line at the configured log level; a no-op when `logLevel === 'off'`. */
   protected log(message: string): void {
      this.tracer.logAt(this.logLevel, message);
   }
}
