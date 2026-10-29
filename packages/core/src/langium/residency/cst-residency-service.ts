/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { asMutable, type Clock, Debouncer, Format, type Tracer, UNRECORDED_VERSION } from '@hydranium/protocol';
import {
   type AstNode,
   type AstReflection,
   AstUtils,
   DocumentState,
   isAstNode,
   isMultiReference,
   isReference,
   type ReferenceInfo,
   type LangiumDocument,
   type LangiumDocumentFactory,
   type LangiumDocuments,
   URI
} from '@hydranium/langium';
import { type HydraniumTextDocuments } from '../../documents/hydranium-text-documents.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';

/**
 * Default priority of the CST-residency pass. Deliberately very high so it runs
 * *last* among `Validated` build-phase passes (the registry iterates priority
 * ascending).
 *
 * The ordering is defensive, not load-bearing: the pass only arms or cancels an
 * idle timer, so every pass at `Validated` reads a resident CST whichever order
 * they run in, and lowering it changes nothing observable while that holds. It
 * becomes load-bearing the moment the shed stops being deferred — a pass that
 * frees the CST synchronously has to run after every reader of it.
 */
export const CST_RESIDENCY_PASS_PRIORITY = 1_000_000;

/**
 * CST residency strategy — a discriminated union so each policy carries its own
 * parameters and illegal states are unrepresentable (`idleMs` exists only on the
 * shedding arm), and a further policy slots in as a new arm without reshaping
 * the options.
 *
 * - `{ kind: 'always-keep' }` (default): never shed — the service is a no-op.
 *   The v0 default so wiring the service in is behaviour-neutral, and the runtime
 *   "off" toggle.
 * - `{ kind: 'shed-closed-when-idle', idleMs }`: shed a closed document's CST
 *   once it has been idle (not in any build) for `idleMs`, keeping the AST
 *   resident. Open documents are always kept. The timer starts when a build
 *   includes the document, so `idleMs: 0` sheds a closed document on the tick
 *   after each such build. A shed document that re-enters a build has its CST
 *   grafted back, which parses its text, so a window shorter than the gap
 *   between a document's builds parses a closed document on every build it
 *   rides in.
 */
export type CstResidencyStrategy = { readonly kind: 'always-keep' } | { readonly kind: 'shed-closed-when-idle'; readonly idleMs: number };

/** Construction options for {@link CstResidencyService}. */
export interface CstResidencyOptions extends LogNameOptions {
   /** Residency strategy. Default `{ kind: 'always-keep' }` (no-op). */
   readonly strategy?: CstResidencyStrategy;
   /** Pass priority. Default {@link CST_RESIDENCY_PASS_PRIORITY} (run last at `Validated`). */
   readonly priority?: number;
   /**
    * Optional bytes-per-node figure used to annotate shed traces with an
    * approximate reclaim. **Default `0`** — the framework traces only the exact,
    * grammar-agnostic node count, because per-node CST size depends entirely on
    * the grammar (token sizes, node fan-out, retained string slices) and cannot
    * be estimated framework-side. An adopter that has measured its own workspace
    * may pass a representative value to enrich the trace; it is used for logging
    * only, never for any decision.
    */
   readonly estimatedBytesPerShedNode?: number;
}

/**
 * The build state a shed document is reset to when the identity-preserving graft
 * fails, so the next build re-parses it and rebuilds its CST — and every
 * `reference.$refNode` — before it is relinked or re-indexed. It is
 * `DocumentState.Changed` by necessity: the only state below `Parsed`, hence
 * the only one that forces a re-parse rather than an in-place relink. Exposed
 * as a named landmark of the residency feature (cf.
 * `IntegrityService.SettledState`) so the document builder references the
 * feature's declared recovery contract instead of a bare enum value.
 */
export const CST_REHYDRATION_RESET_STATE: DocumentState = DocumentState.Changed;

/**
 * Whether `document`'s CST has been shed by a residency policy: the AST root is
 * resident but its `$cstNode` was nulled. The built-state and present-root guards
 * exclude the `fromModel` INVALID placeholder and not-yet-parsed documents, which
 * legitimately have no CST. The single definition of "shed", shared by
 * {@link CstResidencyService} and the document builder's rehydrate-on-re-entry
 * seam so the two cannot drift.
 */
export function isCstShed(document: LangiumDocument): boolean {
   return (
      document.state >= DocumentState.Parsed &&
      document.parseResult?.value !== undefined &&
      document.parseResult.value.$cstNode === undefined
   );
}

/**
 * Reattach a CST to a shed document **on demand**, without a rebuild. Both the
 * read side and the build-side rehydrate-on-re-entry seam use it. Re-parses
 * the document's retained text into a throwaway document, then **grafts** the
 * fresh CST onto the already-built, resident AST nodes — preserving AST node
 * identity, so every cross-reference *into* this document (resolved to a resident
 * node) keeps pointing at the same object. The duplicate AST is discarded.
 *
 * Why this is needed: a read-only LSP request (go-to-definition / declaration /
 * implementation / type-definition, call/type hierarchy) reads the *target's*
 * live CST for its range and does **not** run a build, so the build-side
 * rehydrate never fires. Into a currently-closed (shed) file those features would
 * otherwise return "no definition". This restores the real CST so every CST
 * reader works unchanged — it is not a per-feature patch.
 *
 * **Synchronous.** Closed-document text is in memory (Langium's
 * `createTextDocumentGetter` closes over the original string), and
 * {@link LangiumDocumentFactory.fromString} without a `CancellationToken` takes
 * the synchronous `create()` path. That lets the sync `getNameNode` chokepoint
 * drive it.
 *
 * **Identity-preserving graft.** For each AST node (paired by pre-order index
 * with the fresh parse) the fresh `$cstNode` is moved onto the resident node and
 * its CST→AST back-pointer (`cstNode.astNode`) is repointed to the resident node,
 * so CST→AST readers (`findDeclarationNodeAtOffset(root.$cstNode, …).astNode`)
 * reach the real, linked node rather than the throwaway parse. Each
 * `reference.$refNode` is restored the same way (paired over
 * {@link AstUtils.streamReferences}).
 *
 * **Safe degrade.** If the re-parse diverges from the resident AST (a
 * different node count, or a different type, container slot, reference slots
 * or grammar value on any node — should not happen for unchanged text, but a
 * guard against an AST changed in place) the graft is abandoned before any
 * write and the document stays shed. A read-side caller degrades as it did
 * before (no wrong attachment), and the build re-parses.
 *
 * **Module-private mechanism.** The public entry points are
 * {@link CstResidencyService.rehydrateNode} / {@link CstResidencyService.rehydrate},
 * which resolve the factory themselves and are where a future read-side residency
 * hook lands (see their note). The graft invariants live here, unopinionated
 * about policy — and deliberately not exported, so they cannot be invoked (or
 * partially overridden) outside the service.
 *
 * @returns `true` if the document now has a resident CST (already-resident is a
 * no-op `true`); `false` if the text is unrecoverable or the re-parse diverged.
 */
function rehydrateCst(document: LangiumDocument, factory: LangiumDocumentFactory, reflection: AstReflection): boolean {
   const root = document.parseResult?.value;
   if (root === undefined) {
      return false;
   }
   if (root.$cstNode !== undefined) {
      return true; // already resident — idempotent
   }
   const text = document.textDocument?.getText();
   if (text === undefined) {
      return false;
   }
   // No CancellationToken (3rd arg) → synchronous create() path.
   const fresh = factory.fromString(text, document.uri);
   const existingNodes = [...AstUtils.streamAst(root)];
   const freshNodes = [...AstUtils.streamAst(fresh.parseResult.value)];
   // Pre-order follows property order, so a property re-added in place would
   // pair siblings of one type crosswise. Their container slots tell them
   // apart, and their grammar values tell apart siblings that traded slots too.
   const pairsDiffer = (node: AstNode, freshNode: AstNode): boolean =>
      node.$type !== freshNode.$type ||
      node.$containerProperty !== freshNode.$containerProperty ||
      node.$containerIndex !== freshNode.$containerIndex ||
      Object.keys(reflection.getTypeMetaData(node.$type).properties).some(
         property => !sameGrammarValue(Reflect.get(node, property), Reflect.get(freshNode, property))
      );
   if (existingNodes.length !== freshNodes.length || existingNodes.some((node, index) => pairsDiffer(node, freshNodes[index]))) {
      return false; // structural divergence — stay shed rather than mis-attach
   }
   // `streamReferences` yields a node's *own* cross-references only (not its
   // descendants'), in property enumeration order, which a property re-added
   // in place changes. So each pair must hold one property and array index.
   // Checked before any write, so a divergence leaves the document shed rather
   // than half grafted.
   const residentRefs = existingNodes.map(node => [...AstUtils.streamReferences(node)]);
   const freshRefs = freshNodes.map(node => [...AstUtils.streamReferences(node)]);
   const refsDiffer = (refs: ReferenceInfo[], fresh: ReferenceInfo[]): boolean =>
      refs.length !== fresh.length || refs.some((ref, index) => ref.property !== fresh[index].property || ref.index !== fresh[index].index);
   if (residentRefs.some((refs, index) => refsDiffer(refs, freshRefs[index]))) {
      return false;
   }
   for (let index = 0; index < existingNodes.length; index++) {
      const residentNode = existingNodes[index];
      const freshNode = freshNodes[index];
      const freshCst = freshNode.$cstNode;
      asMutable(residentNode).$cstNode = freshCst;
      if (freshCst) {
         // The fresh composite CST node's `astNode` points at the throwaway parse;
         // repoint it (and thus the leaf nodes that inherit via `container.astNode`)
         // at the resident node so CST→AST navigation reaches the linked AST.
         asMutable(freshCst).astNode = residentNode;
      }
      // Restore each reference's `$refNode` from the fresh parse. The resolved
      // `.ref` link is untouched (still resident).
      residentRefs[index].forEach((resident, refIndex) => {
         asMutable(resident.reference).$refNode = freshRefs[index][refIndex].reference.$refNode;
      });
   }
   return true;
}

/**
 * Whether two values of one grammar property match. Child nodes are paired on
 * their own, so a reference counts by its text. A converter's `Date` counts by
 * its time, and any other object as equal, since its equality is unknown.
 */
function sameGrammarValue(value: unknown, freshValue: unknown): boolean {
   if (Array.isArray(value)) {
      return (
         Array.isArray(freshValue) &&
         value.length === freshValue.length &&
         value.every((item, index) => sameGrammarValue(item, freshValue[index]))
      );
   }
   if (isReference(value) || isMultiReference(value)) {
      return (isReference(freshValue) || isMultiReference(freshValue)) && value.$refText === freshValue.$refText;
   }
   if (isAstNode(value)) {
      return isAstNode(freshValue);
   }
   if (value instanceof Date) {
      return freshValue instanceof Date && value.getTime() === freshValue.getTime();
   }
   if (typeof value === 'object' && value !== null) {
      return typeof freshValue === 'object' && freshValue !== null;
   }
   return Object.is(value, freshValue);
}

/**
 * Keeps a document's CST available to the readers that need one, shedding it
 * for documents that have gone idle and re-grafting on demand.
 *
 * Each build refreshes the idle window of the documents in its batch. When a
 * closed, sheddable document's window elapses, every AST node's `$cstNode` and
 * every reference's `$refNode` are nulled, and the CST becomes unreachable with
 * the `Range`s and `Position`s only it holds. The reference index's segments, and a
 * description's segments once read, share the CST's `Range` objects, so
 * those stay.
 *
 * **Terminology.** *Residency* is the state axis (is the CST in memory? —
 * `resident` vs `shed`); *shed* is both the act and the policy vocabulary (drop
 * the CST and every `$refNode`, the document itself survives with its AST,
 * links, and identity intact — deliberately NOT "evict", which would suggest the
 * whole document leaves); *rehydrate* is the restore (re-derive the CST from the
 * retained source text and graft it back, identity-preserving — deliberately not
 * "reload", which would suggest bytes coming back unchanged).
 *
 * **Re-entry is safe.** A shed document that later re-enters a build has its
 * CST and every `$refNode` grafted back first ("rehydrate-on-re-entry"),
 * keeping its AST nodes so dependents outside the build stay linked to them.
 * `HydraniumDocumentBuilder.rehydrateShedDocuments` grafts a document that is
 * relinked or re-validated, before the build's phases, and
 * `HydraniumLangiumDocumentFactory.update` one reset to `Changed` whose text
 * has not changed. An edited document is re-parsed, and so is one whose graft
 * is refused or diverges, and a build after it relinks its dependents. That
 * matters because Langium derives the reference index — and thus
 * `IndexManager.isAffected` and the `segment` used by rename /
 * find-references — from `$refNode`. Without rehydration a re-index would
 * silently drop the document's cross-references, and it would no longer be
 * relinked when its targets change.
 *
 * Constructed with `(services, options)` and self-registers a `Validated`
 * `BuildPhasePass`, which is why the framework constructs it eagerly — the pass
 * must be registered before the first build. Shedding itself is opt-in: the
 * bound default strategy is `always-keep`, so the pass runs and sheds nothing
 * until an adopter rebinds the slot with a shedding strategy.
 *
 * **Read-side navigation under a shedding strategy.** Read-only LSP requests do
 * not run a build, so they do not trigger the build-side rehydrate. Features that
 * only read the document under the cursor (completion, symbols, formatting, …)
 * see an open document, never a shed one, and index-based cross-file features
 * (find-references, rename, workspace symbols) read the reference index — both
 * unaffected. What does reach a shed document is anything reading a cross-file
 * *target*: target-range navigation (go-to-definition / declaration /
 * implementation / type & call hierarchy) reads the target's live CST for its
 * range, and hover/completion documentation reads the target's preceding comment
 * out of the same CST. Into a currently-closed (shed) file the CST is restored on
 * demand by the identity-preserving graft of {@link rehydrateNode} /
 * {@link rehydrate}, driven transparently from the framework
 * `NameProvider.getNameNode` chokepoint, the comment provider, and
 * `HydraniumLangiumDocuments.getOrCreateDocument`.
 */
export interface CstResidencyService {
   /**
    * Ensure `document` has a CST, re-parsing its retained text if it was shed
    * and that text is the one its AST was parsed from. A resident document is
    * left exactly as it is, so this is safe to call on a hot path and safe to
    * call twice. A document whose graft diverged is not attempted again on the
    * same text.
    */
   rehydrate(document: LangiumDocument): void;

   /**
    * Node-level convenience over {@link rehydrate}, cheap enough for an
    * unconditional call: a node whose `$cstNode` is already set returns
    * without resolving its document, and a node outside any document, such as
    * a detached synthetic node, has nothing to restore and returns too.
    */
   rehydrateNode(node: AstNode): void;
}

export class DefaultCstResidencyService implements CstResidencyService {
   protected readonly strategy: CstResidencyStrategy;
   /** Bytes-per-node for the optional reclaim estimate in traces; `0` disables it. */
   protected readonly estimatedBytesPerShedNode: number;
   protected readonly clock: Clock;
   protected readonly tracer: Tracer;
   protected readonly textDocuments: HydraniumTextDocuments;
   protected readonly langiumDocs: LangiumDocuments;
   /**
    * Per-document idle timers (`shed-closed-when-idle` only). Each is a
    * {@link Debouncer}: re-`schedule()`d every time the document is used (rides
    * in a build batch), it fires once the document has been idle for `idleMs` and
    * sheds it. Lazily created, keyed by URI string, reused across shed/rehydrate
    * cycles, and all cancelled by {@link dispose}.
    */
   protected readonly idleTimers = new Map<string, Debouncer>();
   /**
    * The text each document's graft diverged on. Until its text changes, the
    * document is not shed again: an AST the build keeps mutating away from its
    * text would otherwise cost a graft, a re-parse and a build on every
    * re-entry. Keyed by document, because the re-parse after a divergence
    * replaces the root.
    */
   protected readonly diverged = new WeakMap<LangiumDocument, string>();
   protected shedTotal = 0;

   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: CstResidencyOptions = {}
   ) {
      this.strategy = options.strategy ?? { kind: 'always-keep' };
      this.estimatedBytesPerShedNode = options.estimatedBytesPerShedNode ?? 0;
      this.clock = services.Clock;
      this.tracer = services.Tracer.for(options.logName ?? 'CstResidency').trace('instantiated');
      this.textDocuments = services.workspace.TextDocuments as HydraniumTextDocuments;
      this.langiumDocs = services.workspace.LangiumDocuments;
      services.workspace.BuildPhasePassService.register({
         id: 'framework:cst-residency:shed',
         phase: DocumentState.Validated,
         priority: options.priority ?? CST_RESIDENCY_PASS_PRIORITY,
         run: documents => this.onBuild(documents)
      });
   }

   /**
    * Restore `document`'s shed CST on demand — the ergonomic entry point over
    * {@link rehydrateCst} (resolves the document factory itself). A no-op when
    * the CST is resident, so read-side seams call it unconditionally.
    *
    * **Residency note (deliberate).** Rehydration does NOT count as a "use" for
    * the `shed-closed-when-idle` idle timer (which is refreshed only by build
    * inclusion). Consequence: a browse-heavy but never-rebuilt closed document
    * keeps re-grafting on each navigation rather than staying resident. This is
    * a chosen trade-off — build-recency covers the churn motivation, and a
    * read-side residency hook (refresh the timer / count re-grafts) is deferred
    * until navigation latency on shed files is actually observed to hurt. This
    * method is where that hook goes.
    */
   rehydrate(document: LangiumDocument): void {
      const root = document.parseResult?.value;
      // A graft from other text would attach its CST to nodes it does not
      // describe. `shed` records the text the AST was parsed from.
      // A diverged graft diverges again on the same text, so it is not parsed twice.
      const parsedFrom = root === undefined ? undefined : this.services.workspace.ModelLedger.textOf(root);
      if (
         root === undefined ||
         root.$cstNode !== undefined ||
         parsedFrom === undefined ||
         parsedFrom !== document.textDocument?.getText() ||
         this.hasDiverged(document)
      ) {
         return;
      }
      if (!rehydrateCst(document, this.services.workspace.LangiumDocumentFactory, this.services.AstReflection)) {
         this.diverged.set(document, parsedFrom);
      }
   }

   /**
    * Node-level convenience over {@link rehydrate}: a resident node (its
    * `$cstNode` is set — true for every node of a non-shed document) returns
    * without even resolving the document, so hot read paths
    * (`getNameNode`, comment lookup) call this unconditionally.
    */
   rehydrateNode(node: AstNode): void {
      if (node.$cstNode !== undefined) {
         return;
      }
      const document = AstUtils.findRootNode(node).$document;
      if (document) {
         this.rehydrate(document);
      }
   }

   /**
    * After each build, refresh the idle timer of every document in the batch: an
    * open document keeps its CST (its timer is cancelled — formatting, hover and
    * incremental edits need the CST), while a closed, sheddable document (re)arms
    * its idle timer. Being relinked as a hot dependent therefore keeps a document
    * resident, and a genuinely idle one sheds once `idleMs` elapses. No-op under
    * `always-keep`. "Use" is build inclusion only; read-side navigation
    * ({@link rehydrate}) deliberately does not count — see its note.
    */
   protected onBuild(documents: readonly LangiumDocument[]): void {
      if (this.strategy.kind === 'always-keep') {
         return;
      }
      for (const document of documents) {
         const uri = document.uri.toString();
         if (this.textDocuments.isOpenInAnyClient(uri) || !this.canShed(document) || !this.isSheddable(document)) {
            this.idleTimers.get(uri)?.cancel();
            continue;
         }
         this.idleTimerFor(uri).schedule();
      }
   }

   /**
    * The lazily-created idle {@link Debouncer} for `uri`. `idleMs` is read once at
    * creation from the (necessarily `shed-closed-when-idle`) strategy; the fire
    * handler re-resolves the live document so a shed/rehydrate cycle that replaced
    * the document object still sheds the current one.
    */
   protected idleTimerFor(uri: string): Debouncer {
      let timer = this.idleTimers.get(uri);
      if (timer === undefined) {
         const idleMs = this.strategy.kind === 'shed-closed-when-idle' ? this.strategy.idleMs : 0;
         timer = new Debouncer(this.clock, () => this.onIdle(uri), { delayMs: idleMs });
         this.idleTimers.set(uri, timer);
      }
      return timer;
   }

   /**
    * Idle-timer fire: shed the document's CST if it is still closed and resident.
    * Re-checks open-state (a reopen within the window cancels the timer, but guard
    * anyway) and resolves the current document by URI (it may have been deleted,
    * or its object replaced by a rebuild). Re-checks {@link canShed} and
    * {@link isSheddable} too. The timer was armed by an earlier build, and the
    * document may since be mid-rebuild or have gained an unresolved reference
    * in a cancelled build.
    */
   protected onIdle(uri: string): void {
      if (this.textDocuments.isOpenInAnyClient(uri)) {
         return;
      }
      const document = this.langiumDocs.getDocument(URI.parse(uri));
      if (document === undefined || !this.canShed(document) || !this.isSheddable(document)) {
         return;
      }
      this.shedTotal += this.shed(document);
   }

   /** Cancel every armed shed, so a document that has gone idle keeps its CST. */
   cancelPendingShed(): void {
      for (const timer of this.idleTimers.values()) {
         timer.dispose();
      }
      this.idleTimers.clear();
   }

   /** Whether `document`'s graft diverged on the text its root was parsed from. */
   protected hasDiverged(document: LangiumDocument): boolean {
      const text = this.diverged.get(document);
      return text !== undefined && text === this.services.workspace.ModelLedger.textOf(document.parseResult.value);
   }

   /**
    * Whether `document` can be shed without losing its AST identity or its
    * references. Only a `Validated` document qualifies: the idle timer can fire
    * while a build waits between documents, and a build that indexes a
    * document's references without their CST drops them from the reference
    * index. Its root needs a recorded version, because `shed` then records no
    * text and the graft refuses it. A document whose graft diverged on its
    * current text would cost a parse on every re-entry. Checked before
    * {@link isSheddable}, so an override of that policy keeps these guards.
    */
   protected canShed(document: LangiumDocument): boolean {
      return (
         document.state === DocumentState.Validated &&
         !this.hasDiverged(document) &&
         this.services.workspace.ModelLedger.versionOf(document.parseResult.value) !== UNRECORDED_VERSION
      );
   }

   /**
    * Whether a closed document may have its CST shed. Only documents whose text
    * a re-parse can recover are sheddable, because a re-entry whose graft
    * diverges re-parses from disk. The default admits `file`-scheme documents
    * and excludes synthetic / in-memory documents — e.g. built-in definitions
    * registered under a custom URI scheme — for which that re-parse would
    * `readFile` a non-existent path. A document with an unresolved
    * reference stays resident too: Langium relinks it on every update, so a shed
    * would only buy a re-graft each time. Adopters override to refine.
    */
   protected isSheddable(document: LangiumDocument): boolean {
      return document.uri.scheme === 'file' && !document.references.some(reference => reference.error !== undefined);
   }

   /**
    * Shed one document's CST: null every AST node's `$cstNode` and every
    * reference's `$refNode`. Returns the number of `$cstNode`s cleared (0 if the
    * document is unparsed or already shed).
    */
   protected shed(document: LangiumDocument): number {
      const root = document.parseResult?.value;
      if (root === undefined || root.$cstNode === undefined) {
         return 0;
      }
      // Readers of the parsed text, the `'text-diagnostics'` fingerprint among
      // them, otherwise see none once the CST is gone. Recorded in the ledger
      // directly: no root is produced, and reconciling it with the store would
      // step a closed document's sequence for a root behind its text.
      const ledger = this.services.workspace.ModelLedger;
      const version = ledger.versionOf(root);
      if (version !== UNRECORDED_VERSION) {
         ledger.record(root, version, ledger.textOf(root));
      }
      let cleared = 0;
      for (const node of AstUtils.streamAst(root)) {
         if (node.$cstNode) {
            (node as { $cstNode?: unknown }).$cstNode = undefined;
            cleared++;
         }
      }
      for (const reference of document.references ?? []) {
         if (reference.$refNode) {
            (reference as { $refNode?: unknown }).$refNode = undefined;
         }
      }
      if (cleared > 0) {
         this.tracer.debug(`shed CST of ${document.uri.toString()}: ${cleared} nodes${this.estimateSuffix(cleared)}`);
      }
      return cleared;
   }

   /**
    * ` (~<bytes> reclaimed est.)` when {@link estimatedBytesPerShedNode} is set,
    * else the empty string — so the exact node count is always logged and the
    * (grammar-specific, opt-in) byte estimate is appended only when configured.
    */
   protected estimateSuffix(nodeCount: number): string {
      return this.estimatedBytesPerShedNode > 0 ? ` (~${Format.bytes(nodeCount * this.estimatedBytesPerShedNode)} reclaimed est.)` : '';
   }
}
