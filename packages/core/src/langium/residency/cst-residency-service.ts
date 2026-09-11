/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { asMutable, type Clock, Debouncer, Format, type Tracer } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   DocumentState,
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
 *   resident. Open documents are always kept. `idleMs: 0` sheds as soon as a
 *   document is closed (a pure close-triggered threshold of this strategy).
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
 * The build state a shed document must be reset to so the next build re-parses it
 * and rebuilds its CST — and every `reference.$refNode` — before it is relinked or
 * re-indexed (rehydration). It is `DocumentState.Changed` by necessity: the only
 * state below `Parsed`, hence the only one that forces a re-parse rather than an
 * in-place relink. Exposed as a named landmark of the residency feature (cf.
 * `IntegrityService.SettledState`) so the document builder references the feature's
 * declared recovery contract instead of a bare enum value.
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
 * Reattach a CST to a shed document **on demand**, without a rebuild — the
 * read-side counterpart of the build-side rehydrate-on-re-entry seam. Re-parses
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
 * **Safe degrade.** If the re-parse diverges structurally from the resident AST
 * (different node count — should not happen for unchanged text, but a guard
 * against drift) the graft is abandoned and the document stays shed; the caller
 * degrades exactly as it did before (no wrong attachment).
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
function rehydrateCst(document: LangiumDocument, factory: LangiumDocumentFactory): boolean {
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
   if (existingNodes.length !== freshNodes.length) {
      return false; // structural divergence — stay shed rather than mis-attach
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
      // Restore each reference's `$refNode` from the fresh parse. `streamReferences`
      // yields a node's *own* cross-references only (not its descendants'), so this
      // must run per node — paired by the stable key/array order a re-parse of the
      // same text reproduces. The resolved `.ref` link is untouched (still resident).
      const residentRefs = [...AstUtils.streamReferences(residentNode)];
      const freshRefs = [...AstUtils.streamReferences(freshNode)];
      if (residentRefs.length === freshRefs.length) {
         for (let refIndex = 0; refIndex < residentRefs.length; refIndex++) {
            asMutable(residentRefs[refIndex].reference).$refNode = freshRefs[refIndex].reference.$refNode;
         }
      }
   }
   return true;
}

/**
 * Residency policy that reclaims memory by shedding the concrete syntax tree
 * (CST) of closed documents while keeping their AST resident. Each build refreshes
 * the idle window of the documents in its batch; when a closed, sheddable
 * document's window elapses, every AST node's `$cstNode` and every reference's
 * `$refNode` are nulled, and the CST root, `Range`s and `Position`s become
 * unreachable and are collected.
 *
 * **Terminology.** *Residency* is the state axis (is the CST in memory? —
 * `resident` vs `shed`); *shed* is both the act and the policy vocabulary (drop
 * the CST and every `$refNode`, the document itself survives with its AST,
 * links, and identity intact — deliberately NOT "evict", which would suggest the
 * whole document leaves); *rehydrate* is the restore (re-derive the CST from the
 * retained source text and graft it back, identity-preserving — deliberately not
 * "reload", which would suggest bytes coming back unchanged).
 *
 * **Re-entry is safe.** A shed document that later re-enters a build (because it
 * is relinked as an affected dependent, re-validated, or edited) is re-parsed
 * first by `HydraniumDocumentBuilder.resetToState`
 * ("rehydrate-on-re-entry"), which rebuilds the CST and every `$refNode`. That
 * matters because Langium derives the reference index — and thus
 * `IndexManager.isAffected` and the `segment` used by rename / find-references —
 * from `$refNode`; without rehydration a re-index would silently drop the
 * document's cross-references and its dependents would stop being relinked.
 *
 * Constructed with `(services, options)` and self-registers a `Validated`
 * `BuildPhasePass`, which
 * is why the framework constructs it eagerly — the pass must be registered before
 * the first build. Shedding itself is opt-in: the bound default strategy is
 * `always-keep`, so the pass runs and sheds nothing until an adopter rebinds the
 * slot with a shedding strategy.
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
/**
 * Keeps a document's CST available to the readers that need one, shedding it
 * for documents that have gone idle and re-grafting on demand.
 */
export interface CstResidencyService {
   /**
    * Ensure `document` has a CST, re-parsing its retained text if it was shed.
    * A resident document is left exactly as it is, so this is safe to call on
    * a hot path and safe to call twice.
    */
   rehydrate(document: LangiumDocument): void;

   /**
    * Node-level convenience over {@link rehydrate}, cheap enough for an
    * unconditional call: a node whose `$cstNode` is already set returns
    * without resolving its document.
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
         state: DocumentState.Validated,
         priority: options.priority ?? CST_RESIDENCY_PASS_PRIORITY,
         run: documents => this.onBuild(documents)
      });
   }

   /**
    * Restore `document`'s shed CST on demand — the ergonomic entry point over
    * {@link rehydrateCst} (resolves the document factory itself). No-op `true`
    * when the CST is resident, so read-side seams call it unconditionally.
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
      rehydrateCst(document, this.services.workspace.LangiumDocumentFactory);
   }

   /**
    * Node-level convenience over {@link rehydrate}: a resident node (its
    * `$cstNode` is set — true for every node of a non-shed document) returns
    * `true` without even resolving the document, so hot read paths
    * (`getNameNode`, comment lookup) call this unconditionally.
    */
   rehydrateNode(node: AstNode): void {
      if (node.$cstNode !== undefined) {
         return;
      }
      this.rehydrate(AstUtils.getDocument(node));
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
         if (this.textDocuments.isOpenInAnyClient(uri)) {
            this.idleTimers.get(uri)?.cancel();
            continue;
         }
         if (!this.isSheddable(document)) {
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
    * or its object replaced by a rebuild).
    */
   protected onIdle(uri: string): void {
      if (this.textDocuments.isOpenInAnyClient(uri)) {
         return;
      }
      const document = this.langiumDocs.getDocument(URI.parse(uri));
      if (document === undefined) {
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

   /**
    * Whether a closed document may have its CST shed. Only documents whose text
    * a re-parse on re-entry can recover are sheddable; the default admits
    * `file`-scheme documents (re-read from disk) and excludes synthetic / in-memory
    * documents — e.g. built-in definitions registered under a custom URI scheme —
    * whose text lives only in the CST and would be lost irrecoverably (a later
    * relink would `readFile` a non-existent path). Adopters override to refine.
    */
   protected isSheddable(document: LangiumDocument): boolean {
      return document.uri.scheme === 'file';
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
