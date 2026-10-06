/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultModelState, EditMode, type MaybePromise, SOURCE_URI_ARG } from '@eclipse-glsp/server';
import { Emitter, type Event } from 'vscode-jsonrpc';
import { inject, injectable, optional } from 'inversify';
import { type AstNode, AstUtils, DocumentState, isAstNode, type Reference, URI } from '@hydranium/langium';
import {
   type ClientSession,
   type HydraniumScopeProvider,
   type LanguageTarget,
   type NameProvider,
   type ReferenceCandidateProvider,
   type ServerLanguageServices,
   type ServerSharedServices
} from '@hydranium/core';
import {
   type BaseVersion,
   type ModelVersion,
   type ConflictResolver,
   type Logger,
   type Tracer,
   type TransferElement,
   asModelVersion,
   TIMED_OUT,
   UNRECORDED_VERSION
} from '@hydranium/protocol';
import { type OperationTransition, openOperationOf, workingUriOfCopy } from '../command/hydranium-glsp-operation-command.js';
import { type DiagramStatus, type DiagramStatusEntry } from './diagram-status.js';
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
 *   override `captureSourceRoot` and derive via
 *   `this.baseTracer.for('Name').withUri(uri)`.
 *
 * **Lifecycle ordering.** Reading {@link sourceUri} or {@link sourceRoot}
 * before the first {@link setSourceRoot} call throws via the
 * definite-assignment assertions — callers must invoke `setSourceRoot`
 * (typically from the storage `loadSourceModel` flow) before reading them.
 * The {@link logger}/{@link tracer} are the exception: the injected
 * {@link baseTracer} is always available, so the getters fall back to it
 * before {@link captureSourceRoot} derives the URI-tagged {@link _tracer} —
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
    * Writes of one diagram edit, the first included, that may conflict before
    * the edit is dropped with a warning; each further write reconciles again.
    */
   protected readonly maxSourceModelWrites: number = 3;

   /**
    * Per-class tracer, caller-tagged with this state's runtime subclass name by
    * the `HydraniumTypes.Tracer` binding. {@link captureSourceRoot} derives the
    * URI-tagged {@link _tracer} from it; the {@link tracer}/{@link logger}
    * getters fall back to it before then, so logging is never `undefined`.
    */
   @inject(HydraniumTypes.Tracer) protected readonly baseTracer!: Tracer;

   /** Narrows {@link DefaultModelState.index} to the framework-extended index type. */
   declare readonly index: HydraniumGlspIndex;

   /**
    * The client session this diagram works as, registered under `clientId` by
    * the source-model storage's load and ended with the GLSP client session,
    * or by a resume that takes it over. `undefined` before the load, for
    * GLSP's placeholder client, and when another participant held the id, in
    * which case the diagram does not load.
    *
    * Every write of the diagram goes through this session, which writes only a
    * document it has open and opens nothing. A one-shot write to a document
    * outside the write set goes through
    * {@link ClientSession.withOpen}, and a document the diagram brings into
    * existence through {@link ClientSession.create}.
    */
   modelSession?: ClientSession<AstNode>;

   /**
    * {@link modelSession}, or a throw without one: the diagram never loaded or
    * has ended. Looking `clientId` up through `ModelService.getSession` instead
    * would write as whichever participant holds that id.
    */
   protected requireModelSession(): ClientSession<AstNode> {
      if (!this.modelSession) {
         throw new Error(`No client session is registered for ${this.clientId}; the diagram cannot write`);
      }
      return this.modelSession;
   }

   protected _sourceUri!: string;
   /**
    * The root the last capture took, which every reader of the document
    * shares. A projection that must see an operation's edits reads
    * {@link sourceRoot}, which is a copy of it during an operation.
    */
   protected _sourceRoot!: TRoot;
   /** Settles when the last {@link runExclusive} call queued so far has. */
   protected exclusiveTail: Promise<unknown> = Promise.resolve();
   protected _tracer?: Tracer;
   protected _baseVersion: ModelVersion = asModelVersion(0);
   /**
    * The built root each secondary's version was read from, keyed by
    * canonical URI, and during an operation the root of any other document it
    * first reached. An operation copies a secondary from here, so the copy,
    * the base a conflict reconciles from and the version its write is gated
    * on describe one revision; the registry's current root can be a later
    * build's.
    */
   protected readonly capturedRoots = new Map<string, AstNode>();
   /** Model versions of the secondary write set, keyed by URI. See {@link trackSecondaryDocument}. */
   protected readonly _secondaryVersions = new Map<string, ModelVersion>();

   /** Backing emitter for {@link onSecondaryUrisChanged}; fired only on a membership change. */
   protected readonly secondaryUrisChangedEmitter = new Emitter<void>();

   /** Default of one minute. */
   static readonly DEFAULT_READY_TIMEOUT_MS = 60_000;

   /** Maximum wait inside {@link readyWithTimeout} before raising {@link ModelReadyTimeoutError}. */
   protected readyTimeoutMs: number = AbstractHydraniumGlspState.DEFAULT_READY_TIMEOUT_MS;

   /**
    * Capture a freshly built source root alongside its URI through
    * {@link captureSourceRoot}, and index the AST so downstream GModel
    * projection can resolve elements back to nodes.
    *
    * Capturing the document already captured keeps what the last GModel build
    * registered in the index, which only the next build makes again, and drops
    * an id added through `indexSemanticElement` whose node a rebuild replaced.
    *
    * Throws during an operation: a capture there swaps the root out from under
    * the nodes a handler resolved, and the operation captures when it ends.
    */
   setSourceRoot(uri: string, root: TRoot): void {
      if (openOperationOf(this)) {
         throw new Error(`setSourceRoot(${uri}) during an operation: the operation captures the source root when it ends`);
      }
      const recapture = uri === this._sourceUri;
      this.captureSourceRoot(uri, root);
      if (recapture) {
         this.index.reindexSemanticElements(root, uri);
         this.index.remapSemanticAliases(node => (this.isCurrentBuiltNode(node) ? node : undefined));
      } else {
         this.index.indexSourceRoot(root, uri);
      }
   }

   /**
    * Take `root` as the source root and read everything derived from it: the
    * base version, every tracked secondary version, the URI mirrored into the
    * inherited properties map under {@link SOURCE_URI_ARG}, and the
    * URI-labelled logger. Everything but the index, which
    * {@link setSourceRoot} sets. Override to derive more from a capture.
    */
   protected captureSourceRoot(uri: string, root: TRoot): void {
      this._sourceUri = uri;
      this._sourceRoot = root;
      // The root's own version: the registry's current root can be a later
      // build's, and a write based on its version passes the gate over edits
      // `root` never saw.
      this._baseVersion = this.sharedServices.workspace.ModelLedger.versionOf(root);
      // Re-read the secondary write set: the write that brought us here
      // advanced their versions too, and a stale base version would gate the
      // NEXT command against a superseded number — reporting a conflict that is
      // really this state's own last write.
      this.refreshSecondaryVersions();
      this.set(SOURCE_URI_ARG, uri);
      this._tracer = this.baseTracer.withUri(uri);
      this.tracer.debug(`Captured source root at doc.version=v${this._baseVersion}`);
      this.checkDeclaredLanguage(uri);
   }

   /**
    * Typed override of {@link DefaultModelState.sourceUri}. Narrows the
    * inherited `string | undefined` to `string` (defined after
    * {@link setSourceRoot}; throws on definite-assignment otherwise).
    */
   override get sourceUri(): string {
      return this._sourceUri;
   }

   /** The root operation handlers edit: during an operation a copy of the built root, outside one the built root. */
   get sourceRoot(): TRoot {
      return openOperationOf(this) && this._sourceRoot !== undefined ? (this.workingRootOf(this._sourceUri) as TRoot) : this._sourceRoot;
   }

   /**
    * Run `run` once every earlier call has settled, thrown or not: the
    * boundary that orders operations, undo and redo, and the storage's capture
    * and render. Code running inside it never calls this again, since the
    * call would wait for the section it runs in.
    */
   runExclusive<T>(run: () => MaybePromise<T>): Promise<T> {
      const result = this.exclusiveTail.then(() => run());
      this.exclusiveTail = result.catch(() => undefined);
      return result;
   }

   /**
    * The root of `uri` that operation handlers edit: during an operation a
    * copy made on the first request and returned for the rest of it, outside
    * one the root itself. The root is the built root of `uri`, or `orElse()`
    * when `uri` has no document; `undefined` when neither gives one.
    *
    * A handler that edits another document than the source reaches its root
    * through this, or the edit lands on the root every reader shares. An id
    * added through `indexSemanticElement` for a node of that root names the
    * node's copy from then on.
    */
   workingRootOf(uri: string, orElse?: () => AstNode | undefined): AstNode | undefined {
      const key = this.workingKey(uri);
      const primary = this._sourceUri !== undefined && key === this.workingKey(this._sourceUri);
      const operation = openOperationOf(this);
      if (!operation) {
         return primary ? this._sourceRoot : (this.sharedServices.model.ModelService.getDocument(uri)?.parseResult.value ?? orElse?.());
      }
      let built: AstNode | undefined = primary ? this._sourceRoot : this.capturedRoots.get(key);
      if (built === undefined) {
         // First reached during the operation: frozen now, for the rest of it.
         built = this.readBuiltRoot(uri);
         if (built !== undefined) {
            this.capturedRoots.set(key, built);
         }
      }
      built ??= orElse?.();
      return built === undefined ? undefined : operation.workingRootOf(key, built);
   }

   /** The copy of `uri` the open operation made, without making one. */
   protected existingWorkingRootOf(uri: string): AstNode | undefined {
      return openOperationOf(this)?.existingWorkingRootOf(this.workingKey(uri));
   }

   /**
    * The key of `uri` among an operation's copies: its canonical form, so two
    * spellings of one document share one copy.
    */
   protected workingKey(uri: string): string {
      return this.sharedServices.workspace.DocumentUriPolicy.canonicalUri(uri);
   }

   /**
    * The built node `node` was copied from during an operation; `node` itself
    * for a built node, for a node the operation created, and outside one.
    *
    * A copy has no `$document`, so a lookup that reads its document, scope,
    * reference candidates or project throws or answers for no document.
    * Handlers pass the built node there and keep editing the copy.
    */
   builtNodeOf<T extends AstNode>(node: T): T {
      return openOperationOf(this)?.builtNodeOf(node) ?? node;
   }

   /**
    * A reference to `target` whose `ref` is `target` itself, a copy node
    * included, so an identity comparison later in the operation finds it.
    * `undefined` when no reference can be formed. Outside an operation the
    * nodes are built ones and this is the `ReferenceBuilder`'s answer as is.
    *
    * With `tier: 'own'` the `$refText` is the target's own name as
    * `toOwnReference` gives it, read off `target` itself, so a name the
    * operation edited is the one written; the builder is the target's
    * language's, which a copy node, having no `$document`, would not otherwise
    * reach. `source` plays no part in that tier.
    *
    * By default it is `getReferenceName` from `source`'s context, with the
    * builder of `source`'s language, since `$refText` encoding follows the
    * grammar writing it. That call reads both nodes' projects, to pick the
    * qualification and to refuse a reference across projects the target's is
    * not visible to, and a copy node has none; so it is asked about the built
    * target, which names a target as built, before any rename in the
    * operation, and about {@link builtContextOf} the source. A target the
    * operation created has no built node, and is asked about without a
    * project.
    */
   referenceTo<T extends AstNode>(target: T, source?: AstNode, options: { readonly tier?: 'own' } = {}): Reference<T> | undefined {
      const refText =
         options.tier === 'own'
            ? this.languageServicesFor(target)?.references.ReferenceBuilder.toOwnReference(target)?.$refText
            : this.languageServicesFor(source ?? target)?.references.ReferenceBuilder.getReferenceName(
                 this.builtNodeOf(target),
                 source === undefined ? undefined : this.builtContextOf(source)
              );
      return refText === undefined ? undefined : { ref: target, $refText: refText };
   }

   /**
    * The built node of `node`, or of its nearest container that has one: a
    * node the operation created has no built node, but its container's
    * document and project are its own.
    */
   protected builtContextOf(node: AstNode): AstNode {
      const operation = openOperationOf(this);
      for (let current: AstNode | undefined = node; current; current = current.$container) {
         const built: AstNode = this.builtNodeOf(current);
         if (built !== current || operation?.workingUriOf(current) === undefined) {
            return built;
         }
      }
      return node;
   }

   /**
    * Take `root`, which a write of this state's own produced, as the source
    * root; during an operation the operation takes it and captures it when it
    * ends.
    */
   protected captureWrittenRoot(root: TRoot): void {
      const operation = openOperationOf(this);
      if (operation) {
         operation.recordWrittenRoot(root);
      } else {
         this.setSourceRoot(this._sourceUri, root);
      }
   }

   /**
    * Resync after a write whose reconcile dropped the edit: during an
    * operation the operation undoes its side effects, pushes nothing, and
    * captures the document's current root when it ends.
    */
   protected writeDropped(): void {
      const operation = openOperationOf(this);
      if (operation) {
         operation.recordDropped(this.sharedServices.model.ModelService.getDocument(this._sourceUri)?.parseResult.value);
      } else {
         this.refreshSourceRoot();
      }
   }

   /**
    * Whether `node` belongs to the root its document is built to now, or to no
    * document; a root a rebuild replaced holds only stale nodes.
    */
   protected isCurrentBuiltNode(node: AstNode): boolean {
      const root = AstUtils.findRootNode(node);
      const document = root.$document;
      return (
         document === undefined || this.sharedServices.model.ModelService.getDocument(document.uri.toString())?.parseResult.value === root
      );
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
      // A copy node has no `$document`; without its copy's URI it routes to the diagram's language.
      const workingUri = isAstNode(target) ? workingUriOfCopy(target) : undefined;
      return this.sharedServices.ServiceRegistry.getServicesFor(workingUri ?? target) ?? this.diagramLanguage;
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

   /** URI-tagged once a source root is captured; the class-tagged injected {@link baseTracer} before that. */
   get tracer(): Tracer {
      return this._tracer ?? this.baseTracer;
   }

   /**
    * Model version of the root the last {@link captureSourceRoot} took,
    * frozen until the next one.
    *
    * The base an operation's write is gated on, taken when the operation
    * opens; nothing captures during an operation, so it is the version of the
    * root the operation's copies were made from. See
    * `@hydranium/protocol#ConflictError` for the detection contract.
    *
    * **This, not a number read at write time, is what a write must be gated
    * on.** A version read when the write is issued is the store's current one,
    * so it matches by construction and the gate can never fire.
    */
   get baseVersion(): ModelVersion {
      return this._baseVersion;
   }

   /**
    * {@link baseVersion} as a plain number: the store's version of the text the
    * root was parsed from.
    *
    * `UNRECORDED_VERSION` when the document was not built when the snapshot
    * was taken, which no write matches.
    */
   get version(): number {
      return this._baseVersion;
   }

   // ============================================================
   // Secondary documents — the write set beyond the primary
   // ============================================================

   /**
    * Register `uri` as a document this state also writes, snapshotting its
    * current text-document version.
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
    * {@link baseVersionOf}). Idempotent; registering the primary is ignored,
    * since {@link version} already tracks it. Registering a URI not already in
    * the set fires {@link onSecondaryUrisChanged}.
    */
   trackSecondaryDocument(uri: string): void {
      if (uri === this._sourceUri) {
         return;
      }
      const added = !this._secondaryVersions.has(uri);
      const key = this.workingKey(uri);
      // During an operation, the root the operation copied or first reached, not a later build's.
      const root = (openOperationOf(this) ? this.capturedRoots.get(key) : undefined) ?? this.readBuiltRoot(uri);
      this.recordSecondary(uri, root);
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
    * tracked document's model version is merely refreshed, which happens on
    * every {@link captureSourceRoot} and changes nothing a subscriber cares about.
    *
    * **This exists so no caller has to know when the set can change.** The set is
    * usually discovered rather than known, and the discovery point is an
    * operation handler naming a node — not a read of the source root. A
    * subscriber that instead re-derived the set after each such read would miss
    * exactly that case, and miss it silently: the document would simply never be
    * watched, with nothing logged.
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

   /** Active statuses, least recently set first. See {@link setStatus}. */
   protected readonly statuses = new Map<DiagramStatus, DiagramStatusEntry>();

   /** Backing emitter for {@link onStatusChanged}. */
   protected readonly statusChangedEmitter = new Emitter<void>();

   /**
    * Set `status`'s entry, or withdraw it with `undefined`, and recompute
    * {@link currentStatus} and {@link editMode} from every active entry.
    *
    * `editMode` is derived here and nowhere else: a writer that assigns it
    * directly is overwritten by the next status change, and its write is not
    * announced on {@link onStatusChanged}.
    */
   setStatus(status: DiagramStatus, entry: DiagramStatusEntry | undefined): void {
      const previousEntry = this.statuses.get(status);
      if (previousEntry === undefined && entry === undefined) {
         return;
      }
      const previousStatus = this.currentStatus;
      const previousEditMode = this.editMode;
      // Re-inserted so iteration order is recency, which breaks a severity tie.
      this.statuses.delete(status);
      if (entry !== undefined) {
         this.statuses.set(status, entry);
      }
      this.editMode = [...this.statuses.values()].some(active => active.readonly) ? EditMode.READONLY : EditMode.EDITABLE;
      this.logger.debug(`Status ${status}: ${describeStatusEntry(previousEntry)} → ${describeStatusEntry(entry)}`);
      if (this.currentStatus !== previousStatus || this.editMode !== previousEditMode) {
         this.statusChangedEmitter.fire();
      }
   }

   /** The active entry whose message the client shows: highest severity, then most recently set. */
   get currentStatus(): DiagramStatusEntry | undefined {
      let winner: DiagramStatusEntry | undefined;
      for (const entry of this.statuses.values()) {
         if (entry.message !== undefined && (!winner || severityRank(entry) >= severityRank(winner))) {
            winner = entry;
         }
      }
      return winner;
   }

   /** The active statuses that block editing; empty while the diagram is editable. */
   get readonlyStatuses(): DiagramStatus[] {
      return [...this.statuses].filter(([, entry]) => entry.readonly).map(([status]) => status);
   }

   /** The status that supplies {@link currentStatus}, for a log line naming it. */
   get currentStatusSource(): DiagramStatus | undefined {
      const current = this.currentStatus;
      return [...this.statuses].find(([, entry]) => entry === current)?.[0];
   }

   /** Fires when {@link currentStatus} or {@link editMode} changes. */
   get onStatusChanged(): Event<void> {
      return this.statusChangedEmitter.event;
   }

   /**
    * The base version of a write of `uri`: {@link baseVersion} for the primary,
    * the version taken at {@link trackSecondaryDocument} (refreshed by
    * {@link captureSourceRoot}) for a secondary, `undefined` for anything untracked.
    *
    * `undefined` rather than v0 for an untracked URI deliberately: `0` is a real
    * version meaning "present but never edited", so collapsing the two would let
    * a caller gate a write against a document this state never read.
    */
   baseVersionOf(uri: string): ModelVersion | undefined {
      if (uri === this._sourceUri) {
         return this._baseVersion;
      }
      return this._secondaryVersions.get(uri);
   }

   /** Re-take every registered secondary's built root and the model version of that root. */
   protected refreshSecondaryVersions(): void {
      this.capturedRoots.clear();
      for (const uri of [...this._secondaryVersions.keys()]) {
         this.recordSecondary(uri, this.readBuiltRoot(uri));
      }
   }

   /**
    * The built root of `uri`, looked up through the model service's
    * canonicalizing gateway so a symlinked URI does not strand without one;
    * `undefined` for a URI with no parsed document, whose version is then
    * `UNRECORDED_VERSION`, which no write matches. The store counts a file it
    * has not built at `0`, and so does the placeholder the builder registers
    * before its parse, and a write based on `0` overwrites text this state
    * never read.
    */
   protected readBuiltRoot(uri: string): AstNode | undefined {
      const root = this.sharedServices.model.ModelService.getDocument(uri)?.parseResult.value;
      return root && !this.sharedServices.workspace.ModelLedger.isPlaceholder(root) ? root : undefined;
   }

   /** Take `root` as the secondary `uri` was read at, and its version, `UNRECORDED_VERSION` without one. */
   protected recordSecondary(uri: string, root: AstNode | undefined): void {
      if (root !== undefined) {
         this.capturedRoots.set(this.workingKey(uri), root);
      }
      this._secondaryVersions.set(uri, root ? this.sharedServices.workspace.ModelLedger.versionOf(root) : UNRECORDED_VERSION);
   }

   /** The root the secondary `uri` was read at; see {@link capturedRoots}. */
   protected capturedRootOf(uri: string): AstNode | undefined {
      return this.capturedRoots.get(this.workingKey(uri));
   }

   /**
    * Re-capture the source root from the current Langium document,
    * replacing any orphaned root. A rebuild between an earlier
    * {@link setSourceRoot} and the current read can swap the AST out
    * from under us; downstream consumers (GModel factories, action
    * handlers) must see the root the freshly built document carries.
    */
   protected refreshSourceRoot(): void {
      // The operation captures when it ends.
      if (!this._sourceUri || openOperationOf(this)) {
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
    * The root that `uri`'s text parses to (the text store's, or the built
    * document's when the store holds none) and the store's version of that
    * text, read once the document has validated; `undefined` when it cannot be
    * read. The version is read in the tick the text is, so a write based on it
    * conflicts with any edit made after.
    *
    * **Parsed afresh, never the built root.** The built root can lag the
    * store, and a root behind the text it is versioned with makes the replay
    * drop the edits it lacks. The root is parsed, not linked: an encoder hook
    * reading a reference's `ref` sees `undefined` on it.
    */
   protected async readCurrentRoot(uri: string): Promise<{ root: AstNode; version: ModelVersion } | undefined> {
      const modelService = this.sharedServices.model.ModelService;
      if (!(await modelService.validated(uri).catch(() => undefined))) {
         return undefined;
      }
      const store = this.sharedServices.workspace.TextDocuments;
      const text = store.get(uri)?.getText() ?? modelService.getDocument(uri)?.textDocument.getText();
      if (text === undefined) {
         return undefined;
      }
      const version = asModelVersion(store.version(uri));
      return { root: this.sharedServices.workspace.LangiumDocumentFactory.fromString(text, URI.parse(uri)).parseResult.value, version };
   }

   /**
    * Wait until the captured document reaches `state`, then run
    * {@link onReadyRefreshed} so consumers see a fresh AST. Wraps the
    * wait in {@link Tracer.time} for observability.
    *
    * A source not in the document registry is built first, through
    * `ModelService.rebuild`. For a source with neither a file nor text, that
    * build leaves no document, and this rejects rather than timing out.
    */
   async ready(state: DocumentState): Promise<void> {
      await this.tracer.time(`Wait for state '${DocumentState[state]}'`, () => this.readyWithTimeout(state), 'debug');
      await this.onReadyRefreshed();
   }

   /**
    * Race `ModelService.ensureDocumentState`, which builds a root behind its
    * text, against {@link readyTimeoutMs}. If the timeout fires but the
    * document has already reached `state`, log a warning naming the cause, a
    * root behind its text or a missed phase event, and resolve; otherwise
    * raise {@link ModelReadyTimeoutError} via {@link buildReadyTimeoutError}.
    */
   protected async readyWithTimeout(state: DocumentState): Promise<void> {
      const uri = this._sourceUri;
      const stopwatch = this.sharedServices.Clock.stopwatch();
      const reached = this.sharedServices.model.ModelService.ensureDocumentState(uri, state);
      if ((await this.sharedServices.Clock.raceTimer(reached, this.readyTimeoutMs)) !== TIMED_OUT) {
         return;
      }
      const elapsed = Math.round(stopwatch.elapsedMs);
      // Through the model service's canonicalizing gateway, so a symlinked
      // `_sourceUri` is not reported as a hard timeout.
      const doc = this.sharedServices.model.ModelService.getDocument(uri);
      if (!doc || doc.state < state) {
         throw this.buildReadyTimeoutError(state, elapsed);
      }
      const built = this.sharedServices.workspace.ModelLedger.versionOf(doc.parseResult.value);
      const text = this.sharedServices.workspace.TextDocuments.version(uri);
      if (built !== UNRECORDED_VERSION && built < text) {
         this.logger.warn(
            `No build caught the root up after ${elapsed}ms: the document is at state '${DocumentState[doc.state]}', ` +
               `but its root was parsed from v${built} and the text is at v${text}.`
         );
         return;
      }
      this.logger.warn(
         `Missed '${DocumentState[state]}' notification after ${elapsed}ms; document is already at state ` +
            `'${DocumentState[doc.state]}'. Likely a Langium build-phase event race.`
      );
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
    * Persist a new source-model representation back to the document store after
    * an interactive edit. Adopters wire this against their language-services
    * facade. An operation calls it once, with the model projected from its
    * copies; an undo or redo calls it with the transition resolved onto the
    * current model. An implementation takes the root it wrote through
    * {@link captureWrittenRoot}, which during an operation leaves the capture
    * to the operation.
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
    * `baseVersion` is what the write was authored against: an operation's
    * write, and an undo's or redo's, passes the {@link baseVersion} it read
    * the model at. Adopters that write through the diagram's session forward
    * it as the args' `baseVersion` field; adopters whose write path doesn't go
    * through the session ignore it.
    *
    * **Optional, and every implementation must default it to {@link baseVersion}
    * rather than to `'any'`.** Optional is forced: GLSP's `JsonModelState`
    * declares a one-parameter `updateSourceModel` and calls it with one
    * argument, so a second required parameter makes the state unassignable to
    * the slot it has to fill. Defaulting to the state's own model version is
    * what keeps that from costing anything — an operation handler calling
    * `updateSourceModel(model)` gets the gate, and skipping it has to be typed
    * out as `'any'`.
    */
   abstract updateSourceModel(model: TSourceModel, baseVersion?: BaseVersion): MaybePromise<void>;

   /**
    * `transition` as the documents would hold both ends after a write. A
    * serializer may normalize what it writes, provided normalizing again
    * changes nothing; an end left as recorded makes an undo or redo conflict
    * with the write it follows. Default: unchanged.
    */
   async normalizeTransition(transition: OperationTransition<TSourceModel>): Promise<OperationTransition<TSourceModel>> {
      return transition;
   }

   /** The root `model` parses back to once serialized for `uri`, as a write would leave it; nothing is written. */
   protected async roundTrip(uri: string, model: TransferElement): Promise<AstNode> {
      const text = await this.sharedServices.model.ModelService.modelToText(uri, model);
      return this.sharedServices.workspace.LangiumDocumentFactory.fromString(text, URI.parse(uri)).parseResult.value;
   }
}

const SEVERITY_RANK: Readonly<Record<NonNullable<DiagramStatusEntry['severity']>, number>> = { INFO: 0, WARNING: 1, ERROR: 2, FATAL: 3 };

/** A message without a severity ranks as `INFO`. */
function severityRank(entry: DiagramStatusEntry): number {
   return SEVERITY_RANK[entry.severity ?? 'INFO'];
}

function describeStatusEntry(entry: DiagramStatusEntry | undefined): string {
   if (entry === undefined) {
      return 'inactive';
   }
   const flags = [entry.message === undefined ? undefined : (entry.severity ?? 'INFO'), entry.readonly ? 'readonly' : undefined];
   const message = entry.message === undefined ? '' : ` "${entry.message}"`;
   return `${flags.filter(flag => flag !== undefined).join(' ') || 'active'}${message}`;
}
