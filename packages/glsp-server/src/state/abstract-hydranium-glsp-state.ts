/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultModelState, type MaybePromise, SOURCE_URI_ARG } from '@eclipse-glsp/server';
import { Emitter, type Event } from 'vscode-jsonrpc';
import { inject, injectable, optional } from 'inversify';
import { type AstNode, DocumentState, URI } from '@hydranium/langium';
import {
   type HydraniumScopeProvider,
   type LanguageTarget,
   type NameProvider,
   type ReferenceCandidateProvider,
   type ServerLanguageServices,
   type ServerSharedServices
} from '@hydranium/core';
import type { ConflictResolver, Disposable, Logger, Tracer } from '@hydranium/protocol';
import { type HydraniumGlspIndex } from './hydranium-glsp-index.js';
import { HydraniumTypes } from './hydranium-shared-core-services.js';
import { ModelReadyTimeoutError } from './model-ready-timeout-error.js';

/**
 * GLSP model state base shared by all hydranium adopters. Tracks the source
 * AST root + URI alongside GLSP's GModel, exposes a build-state wait with
 * timeout-and-race semantics, and wires a logger labelled with the adopter's
 * component name + current document URI.
 *
 * **Source-root vs GLSP's `sourceUri`.** GLSP's {@link DefaultModelState}
 * stores `sourceUri` via the loosely-typed properties map
 * (`state.set(SOURCE_URI_ARG, uri)`). This base class makes the URI a
 * first-class typed field set through {@link setSourceRoot}, then mirrors
 * the value into the inherited properties map so legacy code paths that
 * still call `state.get(SOURCE_URI_ARG)` continue to work. The inherited
 * `sourceUri` getter is overridden to a narrowed `string` return (no
 * `undefined` once {@link setSourceRoot} has run).
 *
 * **Hooks.**
 * - {@link onReadyRefreshed} — runs after {@link ready} returns. Default
 *   calls {@link refreshSourceRoot} so callers see a fresh AST after a
 *   wait that may have rebuilt the document. Adopters whose AST is
 *   immutable between build phases can override to a no-op.
 * - {@link buildReadyTimeoutError} — constructs the timeout error with the
 *   workspace-relative path + the document builder's build-status snapshot;
 *   override only to change the error shape (richer per-adopter output comes
 *   from overriding `wsRelativePath` / `formatBuildStatus`).
 * - logging — see {@link baseTracer}. Adopters wanting a different label
 *   override `setSourceRoot` and derive via
 *   `this.baseTracer.for('Name').withUri(uri)`.
 *
 * **Lifecycle ordering.** Reading {@link sourceUri} or {@link sourceRoot}
 * before the first {@link setSourceRoot} call throws via the
 * definite-assignment assertions — callers must invoke `setSourceRoot`
 * (typically from the storage `loadSourceModel` flow) before reading them.
 * The {@link logger}/{@link tracer} are the exception: the injected
 * {@link baseTracer} is always available, so the getters fall back to it
 * before {@link setSourceRoot} derives the URI-tagged {@link _tracer} —
 * logging is never `undefined`.
 */
@injectable()
export abstract class AbstractHydraniumGlspState<TRoot extends AstNode, TSourceModel = string> extends DefaultModelState {
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   /**
    * Conflict-resolution policy consulted when a write races a foreign edit
    * (forward-write, undo, redo, save). Bound by
    * `HydraniumGlspAppModule` to the adopter's choice — default
    * `ReconcilingConflictResolver` (field-level merge) unless the adopter
    * passes a `ForceConflictResolver` (last-writer-wins). Read by
    * `HydraniumGlspRecordingCommand`'s undo / redo and by adopter
    * `updateSourceModel` implementations.
    */
   @inject(HydraniumTypes.ConflictResolver) readonly conflictResolver!: ConflictResolver;

   /**
    * Per-class tracer, caller-tagged with this state's runtime subclass name by
    * the `HydraniumTypes.Tracer` binding. {@link setSourceRoot} derives the
    * URI-tagged {@link _tracer} from it; the {@link tracer}/{@link logger}
    * getters fall back to it before then, so logging is never `undefined`.
    */
   @inject(HydraniumTypes.Tracer) protected readonly baseTracer!: Tracer;

   /** Narrows {@link DefaultModelState.index} to the framework-extended index type. */
   declare readonly index: HydraniumGlspIndex;

   protected _sourceUri!: string;
   protected _sourceRoot!: TRoot;
   protected _tracer?: Tracer;
   protected _version: number = 0;
   /** Based-on versions of the secondary write set, keyed by URI. See {@link trackSecondaryDocument}. */
   protected readonly _secondaryVersions = new Map<string, number>();

   /** Backing emitter for {@link onSecondaryUrisChanged}; fired only on a membership change. */
   protected readonly secondaryUrisChangedEmitter = new Emitter<void>();

   /** Default of one minute. */
   static readonly DEFAULT_READY_TIMEOUT_MS = 60_000;

   /** Maximum wait inside {@link readyWithTimeout} before raising {@link ModelReadyTimeoutError}. */
   protected readyTimeoutMs: number = AbstractHydraniumGlspState.DEFAULT_READY_TIMEOUT_MS;

   /**
    * Capture a freshly built source root alongside its URI, refresh the
    * logger to label log lines with the URI, and re-index the AST so
    * downstream GModel projection can resolve elements back to nodes.
    *
    * Also mirrors `uri` into the inherited properties map under
    * {@link SOURCE_URI_ARG} so legacy GLSP code paths (`state.get(...)`)
    * stay consistent with the typed field.
    */
   setSourceRoot(uri: string, root: TRoot): void {
      this._sourceUri = uri;
      this._sourceRoot = root;
      this._version = this.readDocumentVersion(uri);
      // Re-read the secondary write set for the same reason the primary is
      // re-read: the write that brought us here advanced their versions too, and
      // a stale based-on version would gate the NEXT command against a
      // superseded number — reporting a conflict that is really this state's own
      // last write.
      this.refreshSecondaryVersions();
      this.set(SOURCE_URI_ARG, uri);
      this._tracer = this.baseTracer.withUri(uri);
      this.tracer.debug(`Captured source root at doc.version=v${this._version}`);
      this.checkDeclaredLanguage(uri);
      this.index.indexSourceRoot(root, uri);
   }

   /**
    * Typed override of {@link DefaultModelState.sourceUri}. Narrows the
    * inherited `string | undefined` to `string` (defined after
    * {@link setSourceRoot}; throws on definite-assignment otherwise).
    */
   override get sourceUri(): string {
      return this._sourceUri;
   }

   get sourceRoot(): TRoot {
      return this._sourceRoot;
   }

   /**
    * The language services of the grammar this DIAGRAM TYPE edits, as declared
    * by `AbstractHydraniumGlspDiagramModule.declareLanguage`.
    *
    * **Named for what it is, not for "the language".** Reach for it only when
    * the thing you are asking about lives in the diagram document itself.
    * Anything reached *through* a reference is decided by its own document: use
    * {@link languageServicesFor}. Making that choice explicit at the call site
    * is the point; a neutral-looking `languageServices` invites the diagram's
    * grammar to be applied to a foreign node, which is the defect this whole
    * seam exists to prevent.
    *
    * Injected rather than derived from {@link sourceUri} so it is available
    * before the first {@link setSourceRoot} — GLSP constructs operation
    * handlers at `InitializeClientSession`, well before `RequestModelAction`.
    * `@optional()` so a harness that binds no diagram module still resolves;
    * `undefined` then means no diagram module declared a grammar.
    */
   @inject(HydraniumTypes.DiagramLanguage) @optional() readonly diagramLanguage?: ServerLanguageServices;

   /**
    * The language services owning `target` — an AST node (routed by its
    * document), a URI, or a URI string — falling back to
    * {@link diagramLanguage} when `target` routes nowhere.
    *
    * Use this wherever the thing being named, keyed or completed may live in
    * another document than the diagram. Two registered languages are free to
    * differ in `nameProperties` / `nameSeparator` and in their element-key
    * strategy, so applying the diagram's provider to a foreign node yields a
    * plausible-looking string that matches nothing — silently, with no
    * diagnostic. The fallback covers the genuinely unroutable case, a synthetic
    * node not yet attached to a document, where the diagram's own language is
    * the only defensible answer.
    */
   languageServicesFor(target: LanguageTarget | undefined): ServerLanguageServices | undefined {
      return this.sharedServices.ServiceRegistry.getServicesFor(target) ?? this.diagramLanguage;
   }

   /**
    * The `NameProvider` of the language owning `target` — the shorthand for
    * `languageServicesFor(target)?.references.NameProvider`.
    *
    * The shorthands exist because the long form names `target` twice and
    * threads an optional through a four-link chain, which is enough friction
    * that the tempting alternative is a captured provider — the defect this
    * seam exists to prevent. Keeping the correct call the SHORT one is the
    * point. They stay provider-level rather than operation-level so they
    * compose with every provider method and the state does not grow a naming
    * API of its own.
    */
   nameProviderFor(target: LanguageTarget | undefined): NameProvider | undefined {
      return this.languageServicesFor(target)?.references.NameProvider;
   }

   /** The `ScopeProvider` of the language owning `target`. See {@link nameProviderFor}. */
   scopeProviderFor(target: LanguageTarget | undefined): HydraniumScopeProvider | undefined {
      return this.languageServicesFor(target)?.references.ScopeProvider;
   }

   /** The `ReferenceCandidateProvider` of the language owning `target`. See {@link nameProviderFor}. */
   candidateProviderFor(target: LanguageTarget | undefined): ReferenceCandidateProvider | undefined {
      return this.languageServicesFor(target)?.references.CandidateProvider;
   }

   /**
    * Warn when the loaded document does not route to the grammar this diagram
    * module declared.
    *
    * The declared language is the one fact the module states that the grammar
    * itself does not, so it is the one that can drift — a diagram type pointed
    * at the wrong `LanguageMetaData`, or a file extension reassigned. Both
    * would otherwise surface much later as references resolving against the
    * wrong scope. Only a warning, not a throw: the document is loaded and
    * usable either way, and a hard failure here would take out a diagram over
    * a mismatch that may be intentional in an adopter serving one diagram type
    * over several grammars.
    */
   protected checkDeclaredLanguage(uri: string): void {
      const declared = this.diagramLanguage?.LanguageMetaData.languageId;
      if (declared === undefined) {
         return;
      }
      const actual = this.sharedServices.ServiceRegistry.getServicesFor(uri)?.LanguageMetaData.languageId;
      if (actual !== undefined && actual !== declared) {
         this.tracer.warn(`Diagram module declares language '${declared}' but this document routes to '${actual}'`);
      }
   }

   /** The observability handle as a plain {@link Logger} (a {@link Tracer} is-a Logger). */
   get logger(): Logger {
      return this.tracer;
   }

   /** URI-tagged once {@link setSourceRoot} has run; the class-tagged injected {@link baseTracer} before that. */
   get tracer(): Tracer {
      return this._tracer ?? this.baseTracer;
   }

   /**
    * Text-document version captured at the last {@link setSourceRoot}
    * call. Mirrors the server-side `TextDocuments.version(uri)` counter
    * at that point in time — frozen until the next `setSourceRoot`, then
    * re-read from `LangiumDocuments`.
    *
    * Threaded by `HydraniumGlspRecordingCommand` into
    * {@link updateSourceModel}'s optional `version` parameter so the
    * downstream `ModelService.update` / `.save` call can opt into the
    * conflict gate against the captured based-on version. See
    * `@hydranium/protocol#ConflictError` for the detection contract.
    *
    * Falls back to `0` when the document is absent from `LangiumDocuments`
    * at capture time — the same observable state callers see for a doc
    * that was never opened. Callers that need to distinguish
    * "never-versioned" from "v0" must consult the document registry
    * directly.
    */
   get version(): number {
      return this._version;
   }

   // ============================================================
   // Secondary documents — the write set beyond the primary
   // ============================================================

   /**
    * Register `uri` as a document this state also writes, capturing its current
    * text-document version.
    *
    * A diagram whose layout lives in its own file, or whose canvas creates
    * elements in a referenced semantic document, writes more than the document
    * it was opened on. The primary (`sourceUri`) stays the one that drives
    * GModel projection and the conflict gate; secondaries are the rest of the
    * write set.
    *
    * Registering is the adopter's call because the set is usually discovered
    * rather than known: the semantic document a node belongs to is only
    * identified once the operation names the node. What the framework supplies
    * is the part an adopter cannot reconstruct after the fact — the version each
    * document was at BEFORE the command mutated anything (see
    * {@link capturedVersionOf}). Idempotent; registering the primary is ignored,
    * since {@link version} already tracks it. Registering a URI not already in
    * the set fires {@link onSecondaryUrisChanged}.
    */
   trackSecondaryDocument(uri: string): void {
      if (uri === this._sourceUri) {
         return;
      }
      const added = !this._secondaryVersions.has(uri);
      this._secondaryVersions.set(uri, this.readDocumentVersion(uri));
      if (added) {
         this.secondaryUrisChangedEmitter.fire();
      }
   }

   /**
    * Drop every registered secondary. Call when the write set is rebuilt from
    * scratch. Fires {@link onSecondaryUrisChanged} when the set was non-empty.
    */
   untrackSecondaryDocuments(): void {
      if (this._secondaryVersions.size === 0) {
         return;
      }
      this._secondaryVersions.clear();
      this.secondaryUrisChangedEmitter.fire();
   }

   /**
    * Fires whenever the secondary write set gains or loses a URI — never when a
    * tracked document's captured version is merely refreshed, which happens on
    * every {@link setSourceRoot} and changes nothing a subscriber cares about.
    *
    * **This exists so no caller has to know when the set can change.** The set is
    * usually discovered rather than known, and the discovery point is an
    * operation handler naming a node — not a capture. A subscriber that instead
    * re-derived the set after each capture would miss exactly that case, and miss
    * it silently: the document would simply never be watched, with nothing logged.
    * Announcing the change here moves the obligation to the one place that can
    * always discharge it.
    *
    * The set is the one {@link trackSecondaryDocument} /
    * {@link untrackSecondaryDocuments} maintain. A subclass that writes
    * {@link _secondaryVersions} directly bypasses the notification and owns the
    * consequences.
    */
   get onSecondaryUrisChanged(): Event<void> {
      return this.secondaryUrisChangedEmitter.event;
   }

   /** Registered secondary document URIs, in registration order. */
   get secondaryUris(): readonly string[] {
      return [...this._secondaryVersions.keys()];
   }

   /**
    * Based-on version captured for `uri` — {@link version} for the primary, the
    * value captured at {@link trackSecondaryDocument} (refreshed by
    * {@link setSourceRoot}) for a secondary, `undefined` for anything untracked.
    *
    * `undefined` rather than `0` for an untracked URI deliberately: `0` is a real
    * version meaning "present but never edited", so collapsing the two would let
    * a caller gate a write against a document it never captured.
    */
   capturedVersionOf(uri: string): number | undefined {
      if (uri === this._sourceUri) {
         return this._version;
      }
      return this._secondaryVersions.get(uri);
   }

   /**
    * Read a document's current text-document version through the model service's
    * canonicalizing gateway, so a URI spelled through a symlink still resolves to
    * the document keyed by its real path rather than stranding at `0` (which
    * would silently weaken the conflict gate). Optional-chained on `textDocument`
    * so a fixture that omits it does not throw; real Langium documents always
    * populate it.
    */
   protected readDocumentVersion(uri: string): number {
      return this.sharedServices.model.ModelService.getDocument(uri)?.textDocument?.version ?? 0;
   }

   /** Re-read every registered secondary's version from the document store. */
   protected refreshSecondaryVersions(): void {
      for (const uri of [...this._secondaryVersions.keys()]) {
         this._secondaryVersions.set(uri, this.readDocumentVersion(uri));
      }
   }

   /**
    * Re-capture the source root from the current Langium document,
    * replacing any orphaned root. A rebuild between an earlier
    * {@link setSourceRoot} and the current read can swap the AST out
    * from under us; downstream consumers (GModel factories, action
    * handlers) must see the root the freshly built document carries.
    */
   protected refreshSourceRoot(): void {
      if (!this._sourceUri) {
         return;
      }
      const document = this.sharedServices.model.ModelService.getDocument(this._sourceUri);
      // `parseResult.value` is the grammar's entry-rule root for a given URI
      // (even on parse errors), so we cast to `TRoot` rather than runtime-guard
      // it — the same cast the encoder makes on `parseResult.value`. The
      // load-bearing check is the identity test that skips an unchanged root.
      const root = document?.parseResult.value as TRoot | undefined;
      if (root !== undefined && root !== this._sourceRoot) {
         this.setSourceRoot(this._sourceUri, root);
      }
   }

   /**
    * Wait until the captured document reaches `state`, then run
    * {@link onReadyRefreshed} so consumers see a fresh AST. Wraps the
    * wait in {@link Tracer.time} for observability.
    */
   async ready(state: DocumentState): Promise<void> {
      await this.tracer.time(`Wait for state '${DocumentState[state]}'`, () => this.readyWithTimeout(state), 'debug');
      await this.onReadyRefreshed();
   }

   /**
    * Race `ModelService.waitForDocumentState` against
    * {@link readyTimeoutMs}. If the timeout fires but the document has
    * already reached `state` silently (Langium build-phase event race),
    * log a warning and resolve; otherwise raise
    * {@link ModelReadyTimeoutError} via {@link buildReadyTimeoutError}.
    */
   protected async readyWithTimeout(state: DocumentState): Promise<void> {
      const uri = this._sourceUri;
      const stopwatch = this.sharedServices.Clock.stopwatch();
      let timer: Disposable | undefined;

      const timeout = new Promise<void>((resolve, reject) => {
         timer = this.sharedServices.Clock.setTimer(() => {
            const elapsed = Math.round(stopwatch.elapsedMs);
            // Via the canonicalizing gateway (see `readDocumentVersion`), so a
            // symlinked `_sourceUri` is not reported as a hard timeout.
            const doc = this.sharedServices.model.ModelService.getDocument(uri);
            if (doc && doc.state >= state) {
               this.logger.warn(
                  `Missed '${DocumentState[state]}' notification after ${elapsed}ms; document is already at state ` +
                     `'${DocumentState[doc.state]}'. Likely a Langium build-phase event race.`
               );
               resolve();
            } else {
               reject(this.buildReadyTimeoutError(state, elapsed));
            }
         }, this.readyTimeoutMs);
      });

      try {
         await Promise.race([this.sharedServices.model.ModelService.waitForDocumentState(uri, state), timeout]);
      } finally {
         timer?.dispose();
      }
   }

   /**
    * Hook for post-{@link ready} work. Default refreshes the captured
    * source root via {@link refreshSourceRoot} so submission handlers and
    * GModel factories see the AST the now-ready document carries.
    * Adopters whose AST is immutable between build phases override to a
    * no-op.
    */
   protected async onReadyRefreshed(): Promise<void> {
      this.refreshSourceRoot();
   }

   /**
    * Build the {@link ModelReadyTimeoutError} thrown by
    * {@link readyWithTimeout}. Reports the workspace-relative path plus the
    * document builder's current build-status snapshot, both via framework
    * methods — so adopters that override `WorkspaceManager.wsRelativePath` /
    * `DocumentBuilder.formatBuildStatus` for richer output get it here without
    * touching this method. Override only to change the error shape itself.
    */
   protected buildReadyTimeoutError(state: DocumentState, elapsed: number): ModelReadyTimeoutError {
      const workspace = this.sharedServices.workspace;
      const shortPath = workspace.WorkspaceManager.wsRelativePath(this._sourceUri);
      const status = workspace.DocumentBuilder.formatBuildStatus(URI.parse(this._sourceUri));
      return new ModelReadyTimeoutError(shortPath, DocumentState[state], elapsed, status);
   }

   /**
    * Persist a new source-model representation back to the document store
    * after an interactive edit. Adopters wire this against their
    * language-services facade. The `HydraniumGlspRecordingCommand` calls
    * it from its `postChange` hook to commit the edited AST back to the
    * document store.
    *
    * Adopters whose source model is a structured transfer projection
    * round-tripped through `ModelService` should extend
    * `ReconcilingTransferHydraniumGlspState` instead of implementing this
    * directly — it ships a concrete forward-write reconcile template
    * (persist + conflict resolve) over overridable `persist` / `refetch`
    * hooks. This base stays abstract for whole-document-text and read-only
    * adopters.
    *
    * Abstract rather than no-op so adopters that mean to be editable cannot
    * silently lose edits — read-only adopters can throw with a clear message,
    * but the decision is explicit.
    *
    * The read side of the source-model contract (a `sourceModel` getter) is
    * NOT lifted onto the framework state — adopters that consume the
    * recording-command pattern declare `implements JsonModelState<TSourceModel>`
    * themselves so the framework state stays slim. Both halves of the GLSP
    * `JsonModelState` shape meet the framework state via structural
    * intersection at the recording-command call site.
    *
    * `version` is the based-on text-document version captured at command
    * start by `HydraniumGlspRecordingCommand.execute`. Adopters that
    * route through `ModelService.update` / `.save` pass it as the args'
    * `version` field to opt into the conflict gate; adopters that don't
    * care (or whose write path doesn't go through `ModelService`) ignore
    * the parameter. Undefined when the writer is not the recording-command
    * (e.g. external storage refresh paths).
    */
   abstract updateSourceModel(model: TSourceModel, version?: number): MaybePromise<void>;
}
