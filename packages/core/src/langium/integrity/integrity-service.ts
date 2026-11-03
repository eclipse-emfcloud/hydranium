/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ProfileCollector, isPromiseLike, type Logger, type ProfileSession, type Tracer } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   DocumentState,
   interruptAndCheck,
   isMultiReference,
   isOperationCancelled,
   type LangiumDocument,
   UriUtils
} from '@hydranium/langium';
import { CancellationToken, type Disposable } from 'vscode-languageserver';
import { type HydraniumDocumentBuilder, type RunningBuild } from '../document-builder/document-builder.js';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { type WritableFileSystemProvider } from '../workspace/file-system-provider.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumTextDocuments } from '../../documents/hydranium-text-documents.js';
import { Registry } from '../../util/registry.js';
import { type ServerLanguageServices } from '../language-module.js';
import { type ServerSharedServices } from '../module.js';
import { type ExtendedServiceRegistry } from '../service-registry.js';
import { hasSkippedText } from '../workspace/syntax-errors.js';
import { isVirtualUri } from '../workspace/virtual-document.js';
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
    *
    * `run` is shared by every language's call for the same build phase, so
    * a repair here can re-run the rules of a dependent another language
    * enforced. Without it the run is `documents` alone. An implementation
    * adds each document to `run.enforced` before its rules run, and adds one
    * to its `run.reenforced` count when they repair it after that.
    */
   enforceBatch(
      documents: readonly LangiumDocument<TRoot>[],
      phase: DocumentState,
      cancelToken: CancellationToken,
      run?: IntegrityRun
   ): Promise<void>;
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
    * A document whose parse lacks some of its text reaches this state
    * unrepaired: no rule runs on it until it parses.
    *
    * The AST is what this guarantees, not the text. For a closed document whose
    * repair was STAGED rather than written (`'editor'` sync mode),
    * `textDocument` still mirrors disk — read the repair off the AST, or from
    * the staged content the next open consumes.
    *
    * A `Linked`-phase repair relinks the documents that reference the
    * repaired one within the same build, so they settle against the repair.
    * A dependent whose rules already ran has them run again, until they have
    * repaired it again `maxRepeatRepairs` times in the build.
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
 * The shared services of each server that has logged its first silent
 * write-back. Every language of a server holds the same shared services, so
 * keying on them makes {@link DefaultIntegrityService.noteSilentWrite} report once
 * per server rather than once per language.
 */
const silentWriteReported = new WeakSet<ServerSharedServices>();

/**
 * One run of the integrity pass over a build phase's batch, shared by the
 * {@link IntegrityService.enforceBatch} call of every language in it. A
 * `Linked`-phase repair reads it to decide whose rules run again.
 */
export interface IntegrityRun {
   /** The batch, across languages. */
   readonly documents: ReadonlySet<LangiumDocument>;
   /** The documents whose rules have started in this run. */
   readonly enforced: Set<LangiumDocument>;
   /** How often each document's rules repaired it again in this run, after they ran once. */
   readonly reenforced: Map<LangiumDocument, number>;
   /** Whether build-phase passes ran before this one in its phase, and so read the dependents before their relink. */
   readonly passesBefore: boolean;
   /** The token used for cancellation and dependent relinking. */
   readonly cancelToken: CancellationToken;
   /** The owning build. Standalone enforcement has no build completion to lift its guards. */
   readonly build?: RunningBuild;
}

/**
 * Per run, how deeply its `enforceBatch` calls nest, and the dependents
 * repairs selected with the repair that selected them last. Each is relinked
 * once for all the repairs that selected it until then: before its rules run
 * when they are yet to, otherwise when the outermost call, one per language's
 * batch, ends. A repair after its relink selects it again. The outermost
 * call of a run adds its entry and deletes it when it ends, so nested calls
 * share it. Kept here and not on the run, which is a public type.
 */
const deferredRelinks = new WeakMap<
   IntegrityRun,
   { depth: number; dependents: Map<LangiumDocument, { cause: LangiumDocument; service: DefaultIntegrityService }> }
>();

export namespace IntegrityRun {
   /** A run over `documents` in which no rule has run yet. */
   export function create(
      documents: readonly LangiumDocument[],
      options: { passesBefore?: boolean; cancelToken?: CancellationToken; build?: RunningBuild } = {}
   ): IntegrityRun {
      return {
         // A copy, as the builder adds a pulled-in dependent to the batch it hands the passes.
         documents: new Set(documents),
         enforced: new Set(),
         reenforced: new Map(),
         passesBefore: options.passesBefore ?? false,
         cancelToken: options.cancelToken ?? CancellationToken.None,
         build: options.build
      };
   }
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
   /**
    * How often a document's `Linked`-phase rules may repair it again in one
    * build, after a document it references was repaired, before a repair only
    * warns. Rules that settle within it get every run they need. An integer of
    * at least 1, 3 by default.
    */
   readonly maxRepeatRepairs?: number;
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
    * Rules bucketed by the phase they target, then by each `$type` from
    * {@link nodeTypesFor}, preserving the registry's priority order within
    * each bucket. Rebuilt lazily on the first `enforceIntegrity` call after a
    * registry mutation — staleness is detected via reference identity of the
    * registry's cached array (see {@link Registry.all}). Filtering the rule
    * list per call would instead allocate one transient array per document per
    * phase, which a workspace whose documents all settle at the same phase pays
    * on every build.
    */
   protected phaseBuckets = new Map<DocumentState, ReadonlyMap<string, readonly IntegrityRule[]>>();
   protected phaseBucketsFor: readonly IntegrityRule[] | undefined;

   /** Controls how corrections are persisted for closed files. See {@link IntegritySyncMode}. */
   protected readonly syncMode: IntegritySyncMode;

   protected readonly textDocuments: HydraniumTextDocuments<TextDocument>;
   protected readonly fileSystemProvider: WritableFileSystemProvider;
   protected readonly tracer: Tracer;
   /**
    * The framework document builder, used to re-parse + re-link a document in place after a
    * Linked-phase correction (see {@link resyncDocument}).
    */
   protected readonly documentBuilder: HydraniumDocumentBuilder;
   /** See {@link IntegrityServiceOptions.maxRepeatRepairs}. */
   protected readonly maxRepeatRepairs: number;
   /** The rules that mutated each document in its latest `Linked`-phase {@link enforceIntegrity} pass, so a warning can name them. */
   protected readonly mutatingRules = new WeakMap<LangiumDocument, Set<IntegrityRule>>();
   /** The documents whose reconcile or relink threw and requested a rebuild, until a build completes in which nothing threw for them. */
   protected readonly rebuildsAfterThrow = new WeakSet<LangiumDocument>();
   /** The repaired documents that requested a build for the passes before integrity, until a build completes without repairing them. */
   protected readonly rebuildsForPassesBefore = new WeakSet<LangiumDocument>();
   /**
    * The entries of {@link rebuildsAfterThrow} a build clears once it
    * completes. A later re-run or relink in the same build may
    * still throw.
    */
   protected readonly rebuildsAfterThrowToClear = new WeakMap<RunningBuild, Set<LangiumDocument>>();
   /** The entries of {@link rebuildsForPassesBefore} a build clears once it completes, unless it repairs them later. */
   protected readonly rebuildsForPassesBeforeToClear = new WeakMap<RunningBuild, Set<LangiumDocument>>();

   constructor(
      protected readonly services: ServerLanguageServices,
      options: IntegrityServiceOptions = {}
   ) {
      this.textDocuments = services.shared.workspace.TextDocuments;
      this.fileSystemProvider = services.shared.workspace.FileSystemProvider;
      this.tracer = services.shared.Tracer.for(options.logName ?? 'Integrity').trace('instantiated');
      this.documentBuilder = services.shared.workspace.DocumentBuilder;
      this.syncMode = options.syncMode ?? 'silent';
      this.maxRepeatRepairs = options.maxRepeatRepairs ?? 3;
      if (!Number.isInteger(this.maxRepeatRepairs) || this.maxRepeatRepairs < 1) {
         throw new RangeError(
            `The integrity service's maxRepeatRepairs option must be an integer of at least 1, not ${this.maxRepeatRepairs}.`
         );
      }

      // Read the language's IntegrityRuleContribution group and let each
      // contribution register one or many rules through this service (the
      // declarative path; equivalent to imperative `register(rule)` calls).
      // Optional chaining tolerates incomplete test stubs; production
      // wiring always provides the slot via `createServerLanguageModule`.
      const contributions = services.integrity?.rules ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerIntegrityRules(this);
      }
      this.documentBuilder.onBuildEnded(({ completed, build }) => {
         if (completed && build !== undefined) {
            this.rebuildsAfterThrowToClear.get(build)?.forEach(document => this.rebuildsAfterThrow.delete(document));
            this.rebuildsForPassesBeforeToClear.get(build)?.forEach(document => this.rebuildsForPassesBefore.delete(document));
            this.rebuildsAfterThrowToClear.delete(build);
            this.rebuildsForPassesBeforeToClear.delete(build);
         }
      });
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
   async enforceBatch(
      documents: readonly LangiumDocument[],
      phase: DocumentState,
      cancelToken: CancellationToken,
      run: IntegrityRun = IntegrityRun.create(documents, { cancelToken })
   ): Promise<void> {
      const sincePhaseStart = this.services.shared.Clock.stopwatch();
      let mutatedCount = 0;
      let afterThrow: Set<LangiumDocument> | undefined;
      let passesBefore: Set<LangiumDocument> | undefined;
      // Allocate timing state only for a capture or debug logging.
      const session = ProfileCollector.isProfilingEnabled()
         ? this.tracer.profile(`integrity ${this.services.LanguageMetaData.languageId} ${DocumentState[phase]}`)
         : undefined;
      const deferred = deferredRelinks.get(run) ?? { depth: 0, dependents: new Map() };
      deferredRelinks.set(run, deferred);
      deferred.depth++;
      try {
         for (const document of documents) {
            const again = run.enforced.has(document);
            const selected = again ? undefined : deferred.dependents.get(document);
            if (selected !== undefined) {
               // Before its rules run, so they read every repair so far.
               await selected.service.relinkEach(selected.cause, [document], run);
            }
            // Before its rules run, so a repair they cause in turn runs them again.
            run.enforced.add(document);
            let mutated = false;
            if (this.isStructurallyBroken(document)) {
               this.tracer.with(document.uri.toString()).debug('Parse errors: rules skipped until the document parses');
            } else if (await this.enforceIntegrity(document, phase, cancelToken, session)) {
               mutated = true;
               mutatedCount++;
               if (again) {
                  run.reenforced.set(document, (run.reenforced.get(document) ?? 0) + 1);
               }
               // Not cancellable: see `resyncDocument`.
               await this.resyncDocument(document, CancellationToken.None, run);
            }
            // Reached only when no reconcile or relink threw, so once the build completes a later throw may ask for a rebuild again.
            if (phase === DocumentState.Linked) {
               if (this.rebuildsAfterThrow.has(document)) {
                  (afterThrow ??= this.toClear(this.rebuildsAfterThrowToClear, run))?.add(document);
               }
               if (!mutated && this.rebuildsForPassesBefore.has(document)) {
                  (passesBefore ??= this.toClear(this.rebuildsForPassesBeforeToClear, run))?.add(document);
               }
            }
            await interruptAndCheck(cancelToken);
         }
         if (deferred.depth === 1) {
            await this.relinkDeferred(run);
         }
      } catch (error: unknown) {
         if (deferred.depth === 1) {
            // A cancelled build ends before the batch does, and its next build relinks only the changed documents' dependents.
            // A relink that throws there leaves the rest to the builds below, so the cancel is what the caller sees.
            if (isOperationCancelled(error)) {
               await this.relinkDeferred(run).catch(() => undefined);
            }
            // Whatever threw, the dependents still queued hold the replaced nodes, so a build of each repair relinks them.
            new Map([...deferred.dependents.values()].map(({ cause, service }) => [cause, service])).forEach((service, cause) =>
               service.rebuildAfterThrow(cause, run)
            );
         }
         throw error;
      } finally {
         deferred.depth--;
         if (deferred.depth === 0) {
            deferredRelinks.delete(run);
         }
      }
      const totalMs = Math.round(sincePhaseStart.elapsedMs);
      // A repair is the operator's to know of; the timing alone is diagnosis.
      if (mutatedCount > 0) {
         this.tracer.info(`enforce ${DocumentState[phase]}: docs=${documents.length}, mutated=${mutatedCount} [${totalMs}ms]`);
      } else if (totalMs >= 25) {
         this.tracer.debug(`enforce ${DocumentState[phase]}: docs=${documents.length}, mutated=${mutatedCount} [${totalMs}ms]`);
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
      // No parsed node carries a type the reflection does not know, so such a
      // rule never runs. A warning, not a throw: a test reflection may omit the type.
      if (!this.services.shared.AstReflection.getAllTypes().includes(rule.nodeType)) {
         this.tracer.warn(
            `Integrity rule '${this.formatRule(rule)}' is keyed on node type '${rule.nodeType}', ` +
               'which the AST reflection does not know, so no parsed node matches it.'
         );
      }
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
    * Seam: does the parse of `document` lack some of its text? {@link enforceBatch}
    * runs no rule on such a document, because a repair is written back by
    * serializing the AST, and a recovered AST lacks what the parser skipped.
    */
   protected isStructurallyBroken(document: LangiumDocument): boolean {
      return hasSkippedText(document);
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
    * `OperationCancelled` when the token is cancelled before any rule mutated
    * the AST; Langium's build pipeline absorbs the throw at the lock-holder.
    * After a mutation it stops the sweep and returns `true` instead, so the
    * caller can resync what was mutated before the cancellation unwinds.
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
      const rulesByType = this.getPhaseBucket(phase);
      if (rulesByType.size === 0) {
         return false;
      }
      // Read only after a Linked-phase repair. Cleared when such a pass starts, so
      // one that records nothing leaves no older record to be named in its place.
      const recorded = phase > DocumentState.Parsed;
      if (recorded) {
         this.mutatingRules.delete(document);
      }
      let mutating: Set<IntegrityRule> | undefined;
      const relativeUri = this.services.shared.workspace.WorkspaceManager.wsRelativePath(document.uri);
      for (const node of AstUtils.streamAst(document.parseResult.value)) {
         for (const rule of rulesByType.get(node.$type) ?? NO_RULES) {
            const ruleLogger = this.ruleLoggers.get(rule.id)!.with(relativeUri);
            // Scope per rule so the session aggregates self-time by rule id across all
            // nodes; off the profiling path `session` is undefined and we call directly.
            const enforced = session
               ? session.scope(rule.id, () => rule.enforce(node, document, ruleLogger))
               : rule.enforce(node, document, ruleLogger);
            const mutated = isPromiseLike(enforced) ? await enforced : enforced;
            if (mutated) {
               if (recorded && mutating === undefined) {
                  // Only a mutating pass leads to a read, so a pass that mutates nothing allocates nothing.
                  mutating = new Set();
                  this.mutatingRules.set(document, mutating);
               }
               mutating?.add(rule);
               ruleLogger.trace(`[${relativeUri}] Mutated ${this.formatNode(node)}`);
            }
            changed = mutated || changed;
         }
         if (cancelToken !== undefined) {
            try {
               await interruptAndCheck(cancelToken);
            } catch (err: unknown) {
               if (changed && isOperationCancelled(err)) {
                  return true;
               }
               throw err;
            }
         }
      }
      return changed;
   }

   /**
    * Re-serialise the document text after AST mutations, propagate corrections,
    * and re-parse at Parsed phase (safe because linking hasn't occurred yet).
    *
    * Runs to the end whatever `cancelToken` says: the AST is already mutated,
    * and skipping the resync leaves it against unchanged text that the next
    * build does not re-parse. `cancelToken` reaches only the re-parse.
    *
    * A `Linked`-phase repair then relinks the document's dependents, as
    * {@link relinkDependents} describes, within `run`.
    */
   protected async resyncDocument(
      document: LangiumDocument,
      cancelToken?: CancellationToken,
      run: IntegrityRun = IntegrityRun.create([document])
   ): Promise<void> {
      const root = document.parseResult.value as TRoot;
      // Extracted while `document` still holds the text being replaced — the
      // resync that follows overwrites it with `newText`. Absent on a test
      // stub that binds no trivia group; `createServerLanguageModule` always
      // provides it, and an empty registry is already the no-op.
      const trivia = this.services.trivia?.TriviaService;
      const extracted = trivia?.extract(document);
      const serialized = await this.services.serializer.Serializer.serializeAst(root);
      const newText =
         extracted === undefined ? serialized : trivia!.apply(serialized, extracted, UriUtils.toUri(document.textDocument.uri));

      const oldText = document.textDocument.getText();
      if (oldText === newText) {
         return;
      }

      const version = document.textDocument.version;
      // Commit into the store's own document when the URI is open there, rather
      // than into whichever text-document object this build is holding. The two
      // are the same on the LSP path and are NOT when the document was built for
      // an already-open URI through `fromString`: repairing only the build's copy
      // leaves the store — the server's authority on what an open document says —
      // on the unrepaired text, and the reconciling re-parse then redefines
      // `textDocument` onto the store's object and discards the repair with it.
      //
      // Compared against the CST's own text, not against `document.textDocument`.
      // That object IS the store's on the LSP path, so asking it whether the
      // store still agrees compares the store with itself and can only ever say
      // yes — the guard would be vacuous exactly where an editor race can happen.
      // The CST's `fullText` is the text that actually produced this AST, which
      // is the only thing a repair derived from it is valid against. A document
      // with no CST (built from a model rather than parsed) has no better answer
      // than the text it is carrying.
      const parsedFrom = document.parseResult.value.$cstNode?.root.fullText ?? oldText;
      const commit = this.textDocuments.commitRepair(document.textDocument.uri, parsedFrom, newText);
      if (commit.status === 'stale') {
         // An edit landed after the parse this repair came from, so the repair
         // describes text the store has already replaced. Abandon it rather than
         // hand it to `syncCorrections`: an override that persists from there
         // would write a correction over the edit that superseded it. That edit
         // drives a build of its own, which re-runs these rules against what the
         // document actually says.
         //
         // Abandoning the WRITE is only half of it. The build carries on to its
         // settled phase with whatever AST is registered, and every settled
         // consumer reads that AST rather than the store — so leaving the rule's
         // mutation in place would answer questions about this document from a
         // parse of text nobody has. Reconciling discards it by re-reading the
         // store, which is what the document now has to agree with.
         //
         // The re-parse replaces its nodes, so its dependents are relinked now
         // rather than in the edit's build. A reconcile that throws requests no
         // build, as the edit's own build re-reads the document and relinks them.
         const linked = document.state > DocumentState.Parsed;
         await this.reconcileDocument(document, cancelToken);
         if (linked) {
            await this.relinkDependents(document, run);
         }
         return;
      }

      // A committed repair is a new version; a document no client has open keeps
      // its number here, and the re-versioning below moves it once the build
      // has reconciled. Through the store's `update`, so the `instanceof
      // FullTextDocument` gate in the bare `TextDocument.update` does not trip
      // on adopter-custom text-document types.
      const textDocument =
         commit.status === 'committed' ? commit.document : this.textDocuments.update(document.textDocument, [{ text: newText }], version);

      await this.syncCorrections(textDocument, parsedFrom);

      const linked = document.state > DocumentState.Parsed;
      try {
         await this.reconcileDocument(document, cancelToken);
      } catch (error: unknown) {
         // Left unindexed, the document would relink its dependents to the nodes
         // its re-parse replaced. A build of it as changed relinks them.
         if (linked) {
            this.rebuildAfterThrow(document, run);
         }
         throw error;
      }

      // Re-version against the REPAIRED text, after either branch. The repair is
      // a content change the store has not seen: whatever reconciliation ran
      // during the re-parse saw the text on disk, which in `'editor'` sync mode
      // is the PRE-repair text. Leave the sequence describing that and the next
      // open hashes the repair, finds a mismatch and steps the version again, so
      // every base version taken from this build is stale before it is used.
      // An open document keeps the store's own version, which is not this
      // method's to move.
      //
      // Deliberately NOT gated on cancellation, unlike the entry to this method:
      // `syncCorrections` has already written or staged the repair by now, so a
      // preempted build that skipped this would leave the sequence describing
      // text that is no longer there.
      if (!this.textDocuments.isOpen(document.textDocument.uri)) {
         // The root describes the repair too; left at the re-parse's number, a
         // syncing read waits for a build nothing requests. The CST is still
         // the unrepaired text, so the repair is reported as the parsed text.
         this.services.shared.workspace.VersionSyncService.modelProduced(document, { text: newText });
      }

      // Last, so a dependent's repair that resyncs this document again, or a
      // relink that throws, finds it re-versioned already.
      if (linked) {
         await this.relinkDependents(document, run);
      }
   }

   /**
    * Bring `document` back into agreement with the text it is supposed to
    * describe, after a rule has mutated its AST.
    *
    * Used for a correction that was applied and for one that was abandoned,
    * because the document is left inconsistent either way: applied, the text
    * moved under the CST; abandoned, the AST carries a mutation the text never
    * had. Both are the same question — re-read and re-derive — and the phase is
    * what decides how far that has to go.
    */
   protected async reconcileDocument(document: LangiumDocument, cancelToken?: CancellationToken): Promise<void> {
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
   }

   /**
    * Relink the documents that reference `document` within the running build,
    * once a `Linked`-phase repair replaced its nodes or changed its names.
    * They were linked before the repair, so they hold what it replaced.
    *
    * A dependent the build was not linking joins it. Its rules run again
    * through its own language's {@link IntegrityService.enforceBatch} when
    * they have run in `run` or when no language's batch holds it, since a
    * rule may read the links the repair changed. Within {@link enforceBatch}
    * each is relinked once for all the repairs that select it until then:
    * just before its rules run when they are yet to in `run`, otherwise in
    * {@link relinkDeferred}. A dependent that resolves its references lazily
    * is unlinked, so its next read resolves into the repair, and validated
    * again when it was, without its rules, as in its own builds. A dependent
    * re-read from its text has its own dependents relinked too.
    * When build-phase passes ran before integrity, a build of `document` as
    * changed after this one runs them on the dependents again.
    *
    * Without a running build nothing is relinked, as for a document built
    * outside one. When a relink or a re-run throws, a build of `document` as
    * changed after this one relinks them.
    */
   protected async relinkDependents(document: LangiumDocument, run: IntegrityRun): Promise<void> {
      const dependents = this.services.shared.workspace.LangiumDocuments.all
         .filter(other => other !== document && other.state >= DocumentState.ComputedScopes && this.isRelinkedBy(other, document))
         .toArray();
      const deferred = deferredRelinks.get(run)?.dependents;
      if (deferred === undefined) {
         await this.relinkEach(document, dependents, run);
      } else {
         dependents.forEach(dependent => deferred.set(dependent, { cause: document, service: this }));
      }
      // Those passes read the dependents before their relink, and a build of `document` as changed runs
      // them again. Once until a build completes without repairing it, so a rule that never settles cannot loop.
      if (run.passesBefore && dependents.length > 0) {
         if (run.build !== undefined) {
            this.rebuildsForPassesBeforeToClear.get(run.build)?.delete(document);
         }
      }
      if (run.passesBefore && dependents.length > 0 && !this.rebuildsForPassesBefore.has(document)) {
         this.rebuildsForPassesBefore.add(document);
         this.services.shared.workspace.VersionSyncService.rebuildWhileCurrent(document);
      }
   }

   /**
    * Relink, once each, the dependents that repairs in `run` selected and
    * that no turn of their rules relinked. Deferred to the end of the
    * outermost {@link enforceBatch} of `run`, one per language's batch, so
    * k repairs in a batch cost one relink of each, not k.
    */
   protected async relinkDeferred(run: IntegrityRun): Promise<void> {
      const deferred = deferredRelinks.get(run)?.dependents;
      if (deferred === undefined) {
         return;
      }
      // Visits the entries the relinks add, and skips those they relink directly.
      for (const [dependent, { cause, service }] of deferred) {
         deferred.delete(dependent);
         await service.relinkEach(cause, [dependent], run);
      }
   }

   /** Relink `dependents` of the repaired `document` within the running build, and run their rules again where they read it. */
   protected async relinkEach(document: LangiumDocument, dependents: readonly LangiumDocument[], run: IntegrityRun): Promise<void> {
      try {
         for (const dependent of dependents) {
            // Relinked now, it resolves its linking errors against every repair so far.
            deferredRelinks.get(run)?.dependents.delete(dependent);
            const root = dependent.parseResult.value;
            const relinked = await this.documentBuilder.relinkInRunningBuild(dependent, document, run.cancelToken);
            // Re-read from its text, also when left to resolve lazily, so its nodes are new and its own dependents hold the old ones.
            const reread = dependent.parseResult.value !== root;
            if (relinked && (run.enforced.has(dependent) || !run.documents.has(dependent))) {
               await this.reenforce(dependent, document, run);
            }
            if (reread) {
               const registry: ExtendedServiceRegistry<ServerLanguageServices> = this.services.shared.ServiceRegistry;
               const service = registry.getServices(dependent.uri).integrity.IntegrityService;
               // Through its own language's service, which holds its once-guards and rules.
               await (service instanceof DefaultIntegrityService ? service : this).relinkDependents(dependent, run);
            }
         }
      } catch (error: unknown) {
         // The dependents after the one that threw still hold the replaced nodes.
         // A build of `document` as changed relinks them all.
         this.rebuildAfterThrow(document, run);
         throw error;
      }
   }

   /**
    * Build `document` again as changed after the build, which relinks its
    * dependents, once until a build completes in which nothing threw for it,
    * so a throw in that build too ends with its retries.
    */
   protected rebuildAfterThrow(document: LangiumDocument, run: IntegrityRun): void {
      if (run.build !== undefined) {
         this.rebuildsAfterThrowToClear.get(run.build)?.delete(document);
      }
      if (!this.rebuildsAfterThrow.has(document)) {
         this.rebuildsAfterThrow.add(document);
         this.services.shared.workspace.VersionSyncService.rebuildWhileCurrent(document);
      }
   }

   /** The entries of `guard` that the build of `run` clears once it completes. */
   protected toClear(guard: WeakMap<RunningBuild, Set<LangiumDocument>>, run: IntegrityRun): Set<LangiumDocument> | undefined {
      if (run.build === undefined) {
         return undefined;
      }
      let documents = guard.get(run.build);
      if (documents === undefined) {
         documents = new Set<LangiumDocument>();
         guard.set(run.build, documents);
      }
      return documents;
   }

   /**
    * Whether a build where `changed` counts as changed relinks `document`, as
    * Langium's `shouldRelink` decides. Read from the document's links, because
    * its build has dropped its indexed references until it indexes again.
    */
   protected isRelinkedBy(document: LangiumDocument, changed: LangiumDocument): boolean {
      const target = changed.uri.toString();
      return document.references.some(reference => {
         if (reference.error !== undefined) {
            return true;
         }
         // Read through the field, as `items` would resolve an unresolved one, which links nothing.
         if (isMultiReference(reference) && '_items' in reference && !Array.isArray(reference._items)) {
            return false;
         }
         const descriptions = isMultiReference(reference)
            ? reference.items.map(item => item.$nodeDescription)
            : [reference.$nodeDescription];
         return descriptions.some(description => description?.documentUri.toString() === target);
      });
   }

   /**
    * Run the `Linked`-phase rules of `dependent` again after `repaired` was
    * repaired, or warn once naming the rules of that repair when they have
    * repaired `dependent` again {@link maxRepeatRepairs} times in `run`, as
    * the integrity service of `dependent`'s language sets it.
    */
   protected async reenforce(dependent: LangiumDocument, repaired: LangiumDocument, run: IntegrityRun): Promise<void> {
      // Read through the registry's server type, which the intersected `shared` type hides.
      const registry: ExtendedServiceRegistry<ServerLanguageServices> = this.services.shared.ServiceRegistry;
      const service = registry.getServices(dependent.uri).integrity.IntegrityService;
      // Another implementation keeps no bound this service can read, so this one's applies.
      const maxRepeatRepairs = service instanceof DefaultIntegrityService ? service.maxRepeatRepairs : this.maxRepeatRepairs;
      const repairs = run.reenforced.get(dependent) ?? 0;
      if (repairs >= maxRepeatRepairs) {
         if (repairs > maxRepeatRepairs) {
            return;
         }
         // One past the bound marks the warning given.
         run.reenforced.set(dependent, repairs + 1);
         const times = maxRepeatRepairs === 1 ? 'once' : `${maxRepeatRepairs} times`;
         this.tracer
            .with(dependent.uri.toString())
            .warn(
               `${this.formatRules([...(this.mutatingRules.get(repaired) ?? [])])} repaired a document this one references ` +
                  `after its rules repaired it again ${times} in one build, so they keep their last result until the next change. ` +
                  'A rule that does not settle causes this, or rules that repair documents referencing each other.'
            );
         return;
      }
      await service.enforceBatch([dependent], DocumentState.Linked, CancellationToken.None, run);
   }

   /**
    * Propagate a correction to disk and/or the editor. The corrected text is
    * already in the synced store (in-place in {@link resyncDocument}); this
    * method routes the out-of-band part by document registration:
    *
    * - **Open in the language client** → nothing to push here. The AST
    *   mutation rode the current build, so
    *   `DefaultModelService.syncToLanguageClient` (the persistent
    *   integrity-settled listener) mirrors it to the client by
    *   *content* (shadow diff), and the editor shows it as an unsaved change.
    * - **Held only through the data or GLSP head**, or waiting out the release
    *   grace after its last client's connection was lost → the store is the
    *   authority, and those heads read the correction from the settled build.
    *   In silent mode it is also written to disk when the text it was computed
    *   from is what disk holds, since the repair is then the only difference;
    *   otherwise it waits for the next save. Editor mode always waits, and the
    *   repair leaves the document dirty until a save.
    * - **Closed, silent mode** → write to disk directly (disk is authoritative).
    * - **Closed, editor mode** → stage, so the next open takes the correction
    *   over the disk text.
    *
    * A held URI is not closed. Writing it as one persists the holder's unsaved
    * edits with the repair, and staging it leaves text no open reads, because
    * only a first open consumes the stage.
    *
    * `parsedFrom` is the text the repaired AST was parsed from. Without it a
    * held URI's repair is left to the next save.
    */
   protected async syncCorrections(document: TextDocument, parsedFrom?: string): Promise<void> {
      // Only the open/closed question is asked, so no reverse address
      // resolution is needed: a file open under a symlinked path still answers
      // `true`.
      if (this.textDocuments.isOpenInLanguageClient(document.uri)) {
         return;
      }

      // A virtual document has no disk backing, so neither persisting nor
      // staging applies: there is no file to write and no editor that could open
      // one. `URI.fsPath` yields a path for any scheme, so handing this to the
      // provider would address `<cwd>/<contributor>/<name>` — an unrelated
      // location a disk-backed provider refuses outright, turning a repair that
      // was never persistable into a build failure. The correction is already on
      // the AST and in the text store, which is the whole of where a virtual
      // document lives, so there is nothing further to propagate.
      if (isVirtualUri(document.uri)) {
         this.tracer.with(document.uri).debug('Virtual document: correction kept in memory, nothing to persist');
         return;
      }

      // A document waiting out the release grace still holds its lost client's
      // unsaved text, so writing it as a closed file would persist that text.
      if (this.textDocuments.isOpenInAnyClient(document.uri) || this.textDocuments.isReleaseDeferred(document.uri)) {
         if (this.syncMode === 'silent' && parsedFrom !== undefined) {
            await this.persistIfDiskMatches(document, parsedFrom);
         }
         return;
      }

      // Closed files, silent mode: write to disk directly.
      if (this.syncMode === 'silent') {
         const repaired = document.getText();
         // Async write so the integrity pass does not block the event loop on a slow filesystem.
         // In the file's task queue, behind any save already queued: written
         // beside one, the older repair can land last and stay on disk.
         await this.services.shared.workspace.FileSystemTaskQueue.enqueue(document.uri, () =>
            this.fileSystemProvider.writeFile(UriUtils.toUri(document.uri), repaired)
         );
         this.noteSilentWrite(document.uri);
         return;
      }

      // Closed files, editor mode: stage content for the next open.
      this.textDocuments.stagePendingContent(document.uri, document.getText());
   }

   /**
    * Write the repair in `document` to disk when disk still holds `parsedFrom`,
    * the text the repair was computed from — so the write carries the repair
    * and nothing a holder could still discard.
    *
    * The read, the compare and the write run as one task in the file's task
    * queue, so no save of the file lands between them. The store is compared
    * again once the read returns, and the write is skipped if it no longer
    * holds the repair: an edit does not wait for the queue, and writing the
    * older repair then puts text on disk that no participant holds. The
    * skipped repair loses nothing: the edit drives a build of its own, and a
    * save writes the store's text. A file that cannot be read is left alone
    * too: there is no evidence it matches. So is a file an editor opened in the
    * meantime: the editor receives the repair as an unsaved change, and writing
    * it would change the file under the editor.
    */
   protected async persistIfDiskMatches(document: TextDocument, parsedFrom: string): Promise<void> {
      const uri = UriUtils.toUri(document.uri);
      const repaired = document.getText();
      await this.services.shared.workspace.FileSystemTaskQueue.enqueue(document.uri, async () => {
         let onDisk: string;
         try {
            onDisk = await this.fileSystemProvider.readFile(uri);
         } catch (error: unknown) {
            this.tracer.with(document.uri).debug(`Held document unreadable on disk, repair left to the next save: ${String(error)}`);
            return;
         }
         // The file itself, not the store's disk baseline: the baseline moves
         // only when the server hears of a change, so it can still hold the
         // parsed text after another process rewrote the file and before the
         // watcher reports it, and this write would then replace that change.
         if (onDisk !== parsedFrom) {
            return;
         }
         if (this.textDocuments.get(document.uri)?.getText() !== repaired) {
            this.tracer.with(document.uri).debug('Held document changed while disk was read, repair left to that change');
            return;
         }
         if (this.textDocuments.isOpenInLanguageClient(document.uri)) {
            this.tracer.with(document.uri).debug('Editor attached while disk was read, repair left to its save');
            return;
         }
         await this.fileSystemProvider.writeFile(uri, repaired);
         this.textDocuments.setDiskBaseline(document.uri, repaired);
         this.noteSilentWrite(document.uri);
      });
   }

   /**
    * Hand the first repair written to disk in `'silent'` sync mode to
    * {@link reportSilentWrite}. Once per server, whichever language writes,
    * rather than per file: a workspace-wide repair pass would otherwise log a
    * line per document.
    */
   protected noteSilentWrite(uri: string): void {
      if (silentWriteReported.has(this.services.shared)) {
         return;
      }
      silentWriteReported.add(this.services.shared);
      this.reportSilentWrite(uri);
   }

   /**
    * Log a server's first silent write-back, so an adopter learns that
    * integrity rules edit their files and which setting controls it.
    */
   protected reportSilentWrite(uri: string): void {
      this.tracer.info(
         `Wrote an integrity repair to ${uri}. The integrity service's syncMode option is 'silent', ` +
            "which writes repairs to disk; 'editor' leaves disk alone. Later repairs are written without this line."
      );
   }

   /**
    * Format a rule's name for inclusion in user-facing diagnostic strings
    * (error messages thrown during registration, and log lines). Defaults to
    * `label ?? id`. Adopters override when their error reporting needs
    * richer rule context.
    */
   protected formatRule(rule: IntegrityRule): string {
      return rule.label ?? rule.id;
   }

   /** `rules` as the subject of a log line, or a rule left unnamed when an override recorded none. */
   protected formatRules(rules: readonly IntegrityRule[]): string {
      if (rules.length === 0) {
         return 'An integrity rule';
      }
      const names = rules.map(rule => `'${this.formatRule(rule)}'`).join(', ');
      return rules.length === 1 ? `Integrity rule ${names}` : `Integrity rules ${names}`;
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

   /**
    * The `$type`s `rule` runs on. Defaults to its `nodeType` and every subtype,
    * as Langium's validation registry does: no node carries an abstract or union
    * type as its `$type`, so an exact match never runs a rule keyed on one.
    * Read only when the phase buckets rebuild after a registration change, so an
    * override must not depend on anything else.
    */
   protected nodeTypesFor(rule: IntegrityRule): Iterable<string> {
      // A type the reflection does not know still matches itself.
      return [rule.nodeType, ...this.services.shared.AstReflection.getAllSubTypes(rule.nodeType)];
   }

   protected getPhaseBucket(phase: DocumentState): ReadonlyMap<string, readonly IntegrityRule[]> {
      const current = this.rules.all();
      if (this.phaseBucketsFor !== current) {
         const next = new Map<DocumentState, Map<string, IntegrityRule[]>>();
         for (const rule of current) {
            let bucket = next.get(rule.phase);
            if (!bucket) {
               bucket = new Map();
               next.set(rule.phase, bucket);
            }
            // Deduplicated, or a rule runs twice on a node of its own type.
            for (const nodeType of new Set(this.nodeTypesFor(rule))) {
               let rules = bucket.get(nodeType);
               if (!rules) {
                  rules = [];
                  bucket.set(nodeType, rules);
               }
               rules.push(rule);
            }
         }
         this.phaseBuckets = next;
         this.phaseBucketsFor = current;
      }
      return this.phaseBuckets.get(phase) ?? EMPTY_PHASE_BUCKET;
   }
}

// Shared empty results so neither the cold path nor a node no rule matches allocates.
const EMPTY_PHASE_BUCKET: ReadonlyMap<string, readonly IntegrityRule[]> = new Map();
const NO_RULES: readonly IntegrityRule[] = Object.freeze([]);
