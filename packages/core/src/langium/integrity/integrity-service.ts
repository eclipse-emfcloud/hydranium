/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { isPromiseLike, Logger, type ProfileSession, type Tracer } from '@hydranium/protocol';
import { type AstNode, AstUtils, DocumentState, interruptAndCheck, type LangiumDocument, UriUtils } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { type HydraniumDocumentBuilder } from '../document-builder/document-builder.js';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { type WritableFileSystemProvider } from '../../documents/ast-document-manager.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumTextDocuments } from '../../documents/hydranium-text-documents.js';
import { Registry } from '../../util/registry.js';
import { type ServerLanguageServices } from '../language-module.js';
import { type IntegrityRuleRegistry } from './integrity-contribution.js';
import { IntegrityPhase, type IntegrityRule, type IntegritySyncMode } from './integrity-rule.js';

/**
 * Public contract for the per-language integrity-rule runner. Extends the
 * {@link IntegrityRuleRegistry} (which a contribution receives, and which
 * carries `register` alone) with `unregister` and the batch-enforcement
 * entry point driven at the `Parsed` and `Linked` build phases.
 *
 * Adopter overrides go through {@link DefaultIntegrityService}; the
 * interface keeps the public API stable while the correction machinery
 * (`resyncDocument`, `syncCorrections`, formatting hooks, bucket caches)
 * stays `protected` on the default class.
 *
 * Generic over `<TRoot extends AstNode>` so each consumer plugs in
 * their own AST root type.
 */
export interface IntegrityService<TRoot extends AstNode = AstNode> extends IntegrityRuleRegistry {
   /** Remove a rule by id. Returns `true` if a rule was removed. */
   unregister(id: string): boolean;
   /**
    * Enforce all rules for `phase` across a batch of documents that have
    * reached that build state. Per document, run the rules and, if any
    * mutated the AST, resync the document text and propagate corrections.
    * Driven by the framework integrity pass `BuildPipelineIntegration`
    * registers on the build-phase-pass registry; not for general adopter use.
    */
   enforceBatch(documents: readonly LangiumDocument<TRoot>[], phase: DocumentState, cancelToken: CancellationToken): Promise<void>;
   /**
    * Run all rules for `phase` against one document's matching nodes, returning
    * `true` if any rule mutated the AST. The single-document half of
    * {@link enforceBatch}, which drives it per document.
    *
    * Declared here because it is the unit an adopter can drive directly — a
    * rule-level test asserting "this rule fires at this phase and mutates"
    * wants one document and a boolean, not a batch and a resync. Omitting it
    * left that caller reaching through the interface to the default class.
    */
   enforceIntegrity(
      document: LangiumDocument<TRoot>,
      phase: DocumentState,
      cancelToken?: CancellationToken,
      session?: ProfileSession
   ): Promise<boolean>;
}

export namespace IntegrityService {
   /**
    * The earliest document state at which integrity rules have completed and the
    * resulting AST + serialised text are stable. Use this when you need
    * consumable post-integrity content: syncing text to language clients,
    * settling a save, loading the AST for diagram rendering, or resolving a
    * deferred update().
    *
    * Do NOT use this when you need validation diagnostics — those are computed
    * at `DocumentState.Validated` and delivered separately via `publishDiagnostics`
    * or the `onModelUpdated` event.
    *
    * The AST is what this guarantees, not the text. For a closed document whose
    * repair was STAGED rather than written (`'editor'` sync mode),
    * `textDocument` still mirrors disk — read the repair off the AST, or from
    * the staged content the next open consumes.
    *
    * Invariant: integrity rules only register at Parsed or Linked, so the build
    * is guaranteed post-integrity once it advances past `onBuildPhase(Linked)`
    * into `IndexedReferences`. {@link IntegrityService.register} enforces this at
    * runtime; if a future rule needs a later phase, this value must move forward
    * and every call site re-evaluated.
    */
   export const SettledState: DocumentState = DocumentState.IndexedReferences;
}

/**
 * Construction options for {@link DefaultIntegrityService}. All fields
 * optional — the defaults reproduce the framework's behaviour exactly.
 */
export interface IntegrityServiceOptions extends LogNameOptions {
   /**
    * Controls how corrections are persisted for closed files. Fixed at
    * construction time — the runtime contract assumes the mode is
    * stable across the service's lifetime, so changing it after rules
    * have already fired for a document is undefined behaviour. Defaults
    * to `'silent'`. See {@link IntegritySyncMode}.
    */
   readonly syncMode?: IntegritySyncMode;
}

/**
 * Default {@link IntegrityService} implementation. Enforces rules,
 * resyncs document text after mutations, and propagates corrections.
 * The build-pipeline wiring lives in `BuildPipelineIntegration`,
 * which registers the integrity passes that call {@link enforceBatch} —
 * this class owns the rule logic, not the pass lifecycle.
 *
 * **Per-language service.** Bound in the per-language module and
 * constructed with {@link ServerLanguageServices}: shared dependencies
 * (text-document manager, file-system provider, workspace manager,
 * logger, document builder) come from `services.shared`, while
 * serialisation uses the service's own language
 * `services.serializer.Serializer` directly — no per-URI
 * `ServiceRegistry` lookup, because every document this instance
 * processes is its own grammar (the orchestrator routes per language).
 * Adopter subclasses thread the same `(services, options?)` shape.
 */
export class DefaultIntegrityService<TRoot extends AstNode = AstNode> implements IntegrityService<TRoot> {
   /** Registry of integrity rules, keyed by id. Adopters can `unregister(id)` to drop a built-in rule. */
   protected readonly rules = new Registry<IntegrityRule>();
   /** One logger per rule, created at registration and dropped on unregister. */
   protected ruleLoggers = new Map<string, Logger>();

   /**
    * Rules bucketed by the phase they target, preserving the registry's
    * priority order within each bucket. Rebuilt lazily on the first
    * `enforceIntegrity` call after a registry mutation — staleness is detected
    * via reference identity of the registry's cached array (see
    * {@link Registry.all}). Filtering the rule list per call would instead
    * allocate one transient array per document per phase, which a workspace
    * whose documents all settle at the same phase pays on every build.
    */
   protected phaseBuckets = new Map<DocumentState, readonly IntegrityRule[]>();
   protected phaseBucketsFor: readonly IntegrityRule[] | undefined;

   /** Controls how corrections are persisted for closed files. See {@link IntegritySyncMode}. */
   protected readonly syncMode: IntegritySyncMode;

   protected readonly textDocuments: HydraniumTextDocuments<TextDocument>;
   protected readonly fileSystemProvider: WritableFileSystemProvider;
   protected readonly tracer: Tracer;
   /**
    * The framework document builder, used to re-parse + re-link a document in place after a
    * Linked-phase correction (see {@link resyncDocument}). The framework binds
    * `shared.workspace.DocumentBuilder` to {@link HydraniumDocumentBuilder}; the narrowing
    * cast surfaces its single-document phase runner.
    */
   protected readonly documentBuilder: HydraniumDocumentBuilder;

   constructor(
      protected readonly services: ServerLanguageServices,
      options: IntegrityServiceOptions = {}
   ) {
      this.textDocuments = services.shared.workspace.TextDocuments;
      this.fileSystemProvider = services.shared.workspace.FileSystemProvider;
      this.tracer = services.shared.Tracer.for(options.logName ?? 'Integrity').trace('instantiated');
      this.documentBuilder = services.shared.workspace.DocumentBuilder as HydraniumDocumentBuilder;
      this.syncMode = options.syncMode ?? 'silent';

      // Read the language's IntegrityRuleContribution group and let each
      // contribution register one or many rules through this service (the
      // declarative path; equivalent to imperative `register(rule)` calls).
      // Optional chaining tolerates incomplete test stubs; production
      // wiring always provides the slot via `createServerLanguageModule`.
      const contributions = services.integrity?.rules ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerIntegrityRules(this);
      }
   }

   /**
    * Enforce all rules for `phase` across a batch of documents that have
    * reached that build state: per document run the rules and, if any
    * mutated the AST, resync the document text and propagate corrections.
    *
    * Driven by the framework integrity pass `BuildPipelineIntegration`
    * registers — a batch-level (not per-document) pass, because a mutation
    * here reparses the document and must not race the per-document build
    * progression. `cancelToken` is supplied by
    * Langium's build pipeline and honoured between documents (and inside
    * `enforceIntegrity` between nodes) so a build preempted by a
    * concurrent write lock interrupts cleanly rather than running the
    * rule set to completion against a doomed build.
    */
   async enforceBatch(documents: readonly LangiumDocument[], phase: DocumentState, cancelToken: CancellationToken): Promise<void> {
      const phaseStart = performance.now();
      let mutatedCount = 0;
      // Per-rule self-time profiling is opt-in: only spin up a session when the
      // debug threshold is active, so the production `info` path allocates
      // nothing and the hot rule loop stays a single const-branch off `session`.
      const session = Logger.isLevelEnabled('debug') ? this.tracer.profile(`integrity ${DocumentState[phase]}`) : undefined;
      for (const document of documents) {
         const changed = await this.enforceIntegrity(document, phase, cancelToken, session);
         if (changed) {
            mutatedCount++;
            await this.resyncDocument(document, cancelToken);
         }
         await interruptAndCheck(cancelToken);
      }
      const totalMs = Math.round(performance.now() - phaseStart);
      if (totalMs >= 25 || mutatedCount > 0) {
         this.tracer.info(`enforce ${DocumentState[phase]}: docs=${documents.length}, mutated=${mutatedCount} [${totalMs}ms]`);
      }
      // One line per rule (count + self-% + self-ms), sorted by cost — only when profiling.
      session?.report('debug');
   }

   /** Register a single integrity rule. The {@link IntegrityRuleRegistry} entry point. */
   register<T extends AstNode>(rule: IntegrityRule<T>): Disposable {
      // The IntegrityService.SettledState landmark assumes rules only run at Parsed or Linked.
      // Reject anything later — moving the boundary requires updating both SettledState and
      // every call site that depends on "post-integrity" semantics.
      if (!IntegrityPhase.all().includes(rule.phase)) {
         throw new Error(
            `Integrity rule '${this.formatRule(rule)}' registered at phase ` +
               `${DocumentState[rule.phase]} would invalidate IntegrityService.SettledState. ` +
               'Allowed phases are Parsed and Linked.'
         );
      }
      const disposable = this.rules.register(rule);
      this.ruleLoggers.set(rule.id, this.tracer.sub(IntegrityPhase.toString(rule.phase)).sub(rule.label ?? rule.id));
      return {
         dispose: () => {
            disposable.dispose();
            this.ruleLoggers.delete(rule.id);
         }
      };
   }

   /** Remove a rule by id. Returns `true` if a rule was removed. Useful for adopters that want to swap a built-in rule. */
   unregister(id: string): boolean {
      const removed = this.rules.unregister(id);
      if (removed) {
         this.ruleLoggers.delete(id);
      }
      return removed;
   }

   /**
    * Run all rules for the given phase against matching AST nodes. Returns
    * `true` if any rule mutated the AST.
    *
    * Per-rule await is gated by {@link isPromiseLike} so sync rules
    * (the common case) skip the microtask per iteration — important on the
    * Parsed/Linked phases which gate the rest of the build pipeline. The
    * outer caller still pays exactly one microtask tick per
    * `enforceIntegrity` call (any `async` function does), but no per-node ×
    * per-rule cost is added when nothing is async.
    *
    * Single pass over the document's AST, with the phase's rules read from
    * the cached bucket rather than filtered per call.
    *
    * `cancelToken` is honoured at the per-node boundary (after each node's
    * full rule sweep) — coarser than per (node × rule) to avoid a microtask
    * per inner iteration, finer than per-document so a long-running rule set
    * on a large file can still interrupt mid-stream. Throws
    * `OperationCancelled` when the token is cancelled; Langium's build
    * pipeline absorbs the throw at the lock-holder.
    */
   async enforceIntegrity(
      document: LangiumDocument,
      phase: DocumentState,
      cancelToken?: CancellationToken,
      session?: ProfileSession
   ): Promise<boolean> {
      if (cancelToken?.isCancellationRequested) {
         return false;
      }
      let changed = false;
      const rulesForPhase = this.getPhaseBucket(phase);
      if (rulesForPhase.length === 0) {
         return false;
      }
      const relativeUri = this.services.shared.workspace.WorkspaceManager.wsRelativePath(document.uri);
      for (const node of AstUtils.streamAst(document.parseResult.value)) {
         for (const rule of rulesForPhase) {
            if (node.$type === rule.nodeType) {
               const ruleLogger = this.ruleLoggers.get(rule.id)!.with(relativeUri);
               // Scope per rule so the session aggregates self-time by rule id across all
               // nodes; off the profiling path `session` is undefined and we call directly.
               const enforced = session
                  ? session.scope(rule.id, () => rule.enforce(node, document, ruleLogger))
                  : rule.enforce(node, document, ruleLogger);
               const mutated = isPromiseLike(enforced) ? await enforced : enforced;
               if (mutated) {
                  ruleLogger.trace(`[${relativeUri}] Mutated ${this.formatNode(node)}`);
               }
               changed = mutated || changed;
            }
         }
         if (cancelToken !== undefined) {
            await interruptAndCheck(cancelToken);
         }
      }
      return changed;
   }

   /**
    * Re-serialise the document text after AST mutations, propagate corrections,
    * and re-parse at Parsed phase (safe because linking hasn't occurred yet).
    *
    * `cancelToken` is checked at entry so a preempted build skips the
    * serialise / disk-write atomic; the steps inside resync are not further
    * subdivided because each is a single fast operation that does not yield
    * a natural interruption point.
    */
   protected async resyncDocument(document: LangiumDocument, cancelToken?: CancellationToken): Promise<void> {
      if (cancelToken?.isCancellationRequested) {
         return;
      }
      const root = document.parseResult.value as TRoot;
      const newText = await this.services.serializer.Serializer.serializeAst(root);

      const oldText = document.textDocument.getText();
      if (oldText === newText) {
         return;
      }

      const version = document.textDocument.version;
      // Keep the same version so HydraniumTextDocuments doesn't reject subsequent client edits.
      // Use manager.update so the `instanceof FullTextDocument` gate in the bare
      // `TextDocument.update` doesn't trip on adopter-custom text-document types.
      const textDocument = this.textDocuments.update(document.textDocument, [{ text: newText }], version);

      await this.syncCorrections(textDocument);

      if (document.state <= DocumentState.Parsed) {
         // Parsed-phase correction: re-parse only. The build pipeline still runs
         // IndexedContent → ComputedScopes → Linked → … on the fresh AST afterwards,
         // so the document reconciles naturally with no extra work here.
         //
         // Except for a closed document whose repair did not reach disk — `'editor'`
         // sync mode stages it instead of writing it — where the re-parse is SKIPPED:
         // Langium's factory gates the parse on the CST's `fullText`, which still
         // equals the disk text the same call re-reads and redefines `textDocument`
         // over. So `document.textDocument` is NOT post-integrity for such a
         // document — it mirrors disk, and the AST is the only place the repair is
         // legible, until an open consumes the staging.
         await this.documentBuilder.reparse(document, cancelToken);
      } else {
         // Linked-phase (or later) correction. The rule mutated the AST in place but
         // left the CST untouched, so CST and AST now disagree, and Langium's
         // re-parse gate keys on the CST — a bare re-parse would be skipped on a
         // later build and strand the mutated AST. Reconcile within this build via
         // the builder's single-document phase runner, which leaves the document
         // self-consistent (text + CST + AST + links) without re-firing the
         // build-phase listeners (which would re-enter integrity). The phase logic
         // stays in the builder, its proper home, rather than being duplicated here.
         await this.documentBuilder.reparseAndRelink(document, cancelToken);
      }

      // Re-version against the REPAIRED text, after either branch. The repair is
      // a content change the store has not seen: whatever reconciliation ran
      // during the re-parse saw the text on disk, which in `'editor'` sync mode
      // is the PRE-repair text. Leave the sequence describing that and the next
      // open hashes the repair, finds a mismatch and steps the version again, so
      // every `baseVersion` taken from this build is stale before it is used.
      // Falls back to the pre-re-parse number for a URI the store never tracked,
      // where there is no sequence to advance; an OPEN document answers
      // `undefined` and keeps the store's own version, which is not this
      // method's to move.
      //
      // Deliberately NOT gated on cancellation, unlike the entry to this method:
      // `syncCorrections` has already written or staged the repair by now, so a
      // preempted build that skipped this would leave the sequence describing
      // text that is no longer there.
      const reconciled = this.textDocuments.reconcileExternalContent(document.textDocument.uri, newText) ?? version;
      if (document.textDocument.version !== reconciled) {
         this.textDocuments.update(document.textDocument, [], reconciled);
      }
   }

   /**
    * Propagate a correction to disk and/or the editor. The corrected text is
    * already in the synced store (in-place in {@link resyncDocument}); this
    * method routes the out-of-band part by document registration:
    *
    * - **Open in the language client** → nothing to push here. The AST mutation
    *   rode the current build, so `ModelService.syncToLanguageClient` (the
    *   persistent integrity-settled listener) mirrors the corrected text to the
    *   client by *content* (shadow diff) — no authorship rewrite, no second
    *   rebuild.
    * - **Closed, silent mode** → write to disk directly (disk is authoritative).
    * - **Closed, editor mode** → stage so the next open picks it up via applyEdit.
    */
   protected async syncCorrections(document: TextDocument): Promise<void> {
      // Open files: delivery is the ModelService settled listener's job (by
      // content, via the shadow) — nothing to do here. Only the open/closed
      // question is asked, so no reverse address resolution is needed: a file
      // open under a symlinked path still answers `true`.
      if (this.textDocuments.isOpenInLanguageClient(document.uri)) {
         return;
      }

      // Closed files, silent mode: write to disk directly.
      if (this.syncMode === 'silent') {
         // Async write so the integrity pass does not block the event loop on a slow filesystem.
         await this.fileSystemProvider.writeFile(UriUtils.toUri(document.uri), document.getText());
         return;
      }

      // Closed files, editor mode: stage content so the next open picks it up via applyEdit.
      this.textDocuments.stagePendingContent(document.uri, document.getText());
   }

   /**
    * Format a rule's name for inclusion in user-facing diagnostic strings
    * (error messages thrown during registration). Defaults to
    * `label ?? id`. Adopters override when their error reporting needs
    * richer rule context.
    */
   protected formatRule(rule: IntegrityRule): string {
      return rule.label ?? rule.id;
   }

   /**
    * Format an AST node for the per-mutation `trace` log line. Returns
    * `'TypeName'` or `"TypeName('label')"` when the node carries a string
    * `name` (preferred) or `id`. Empty-string name falls through to id;
    * non-string properties are ignored. Adopters override to fold in
    * domain-specific context.
    */
   protected formatNode(node: AstNode): string {
      const named = node as AstNode & { name?: unknown; id?: unknown };
      const fromName = typeof named.name === 'string' && named.name ? named.name : undefined;
      const fromId = typeof named.id === 'string' && named.id ? named.id : undefined;
      const label = fromName ?? fromId;
      return label ? `${node.$type}('${label}')` : node.$type;
   }

   protected getPhaseBucket(phase: DocumentState): readonly IntegrityRule[] {
      const current = this.rules.all();
      if (this.phaseBucketsFor !== current) {
         const next = new Map<DocumentState, IntegrityRule[]>();
         for (const rule of current) {
            let bucket = next.get(rule.phase);
            if (!bucket) {
               bucket = [];
               next.set(rule.phase, bucket);
            }
            bucket.push(rule);
         }
         this.phaseBuckets = next;
         this.phaseBucketsFor = current;
      }
      return this.phaseBuckets.get(phase) ?? EMPTY_PHASE_BUCKET;
   }
}

/** Shared empty result so `getPhaseBucket` doesn't allocate per call on the cold path. */
const EMPTY_PHASE_BUCKET: readonly IntegrityRule[] = Object.freeze([]);
