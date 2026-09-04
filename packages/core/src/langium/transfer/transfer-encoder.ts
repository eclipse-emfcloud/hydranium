/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Tracer,
   type TransferDiagnostic,
   type TransferElement,
   type TransferDocument,
   type TransferTypeFor
} from '@hydranium/protocol';
import { AstUtils, type AstNode, DocumentCache, DocumentState, isAstNode, isReference, type LangiumDocument } from '@hydranium/langium';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { type AstDocument } from '../../documents/ast-document-manager.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { type TransferLspDiagnostic } from '../validation/document-validator.js';

/**
 * Which set of properties {@link TransferEncoder.toTransfer} emits.
 *
 * - `'full'` — every own property of the node (Langium internals aside),
 *   including AST-extension-derived computed scalars and synthetic child
 *   mirrors. This is the wire shape clients consume, and the default.
 * - `'grammar'` — only the grammar-declared properties, per
 *   `AstReflection.getTypeMetaData($type).properties`. Excludes every
 *   computed / synthetic property by construction (no naming convention,
 *   no registration). Yields the authored state a serializer round-trips —
 *   a diffable, acyclic baseline for field-level recording / forward-write
 *   reconcile.
 */
export type TransferMode = 'full' | 'grammar';

/**
 * Per-encode inputs threaded through the {@link TransferEncoder} walk and its
 * hooks. Created once per encode entry (see
 * {@link TransferEncoder.createEncodeContext}) and passed unchanged through
 * the recursion, so every hook invocation of one encode observes the same
 * inputs — unlike instance state, which two interleaving encodes would
 * clobber.
 *
 * Adopters widen the context by overriding `createEncodeContext` with a
 * covariant return type and narrowing the hook parameter types accordingly
 * (TypeScript method bivariance admits the narrowing). An input that changes
 * the encoded output must also be folded into {@link TransferEncoder.rootCacheKey}.
 */
export interface EncodeContext {
   /** Property-set selection for this encode — see {@link TransferMode}. */
   readonly mode: TransferMode;
   /**
    * URI of the document whose subtree is being encoded, when known. The
    * document entry points always set it; the bare {@link TransferEncoder.toTransfer}
    * door derives it from the node's root when the node is attached to a
    * document, and leaves it `undefined` for detached / synthetic subtrees.
    */
   readonly uri?: string;
}

/**
 * The non-root inputs {@link TransferEncoder.assembleTransferDocument} needs to
 * build a wire envelope. Both of the encoder's document paths narrow to this
 * before assembling — a built `LangiumDocument` (whose `uri` / `version` live on
 * its `textDocument`) and a server-internal `AstDocument` snapshot, which
 * satisfies the shape structurally — so the assembly seam has exactly one
 * implementation to override.
 *
 * `diagnostics` accepts either the wire shape (an already-projected
 * `TDiagnostic`, as a snapshot may carry) or a raw LSP {@link Diagnostic}; the
 * assembly projects each through {@link TransferEncoder.toTransferDiagnostic}.
 */
export interface TransferEnvelopeSource<TDiagnostic> {
   readonly uri: string;
   readonly version: number;
   readonly diagnostics: readonly (TDiagnostic | Diagnostic)[];
}

/**
 * One-directional structural mapper from a Langium AST into the wire
 * transfer-model shape ({@link TransferElement}-based JSON).
 *
 * **Direction.** AST → transfer only. The inverse (transfer → AST) is
 * composite: serialise the transfer to text through the `Serializer` bound at
 * `serializer.Serializer` (`serializeTransfer`), then re-parse via Langium's
 * `DocumentBuilder`. No `decode` method exists; the parser is the decoder. The transfer model
 * is intentionally lossy w.r.t. `$container` / `$cstNode` topology and
 * `Reference<T>` resolution — those are re-derived by the parser/linker
 * from text + workspace scope.
 *
 * **Generic parameters.**
 * - `TTransferMap` — per-grammar overlay keyed by AST `$type` strings,
 *   resolving each AST type to its declared wire shape. Default is
 *   `Record<string, TransferElement>`, which collapses every encoded node
 *   to the structural base — adequate for adopters without a generated
 *   overlay; richer adopters declare typed maps for autocomplete on the
 *   encoder's return types.
 * - `TDiagnostic` — wire-diagnostic shape produced by
 *   {@link toTransferDiagnostic}. Constrained to extend
 *   {@link TransferDiagnostic} so the framework default (which constructs a
 *   `TransferDiagnostic` literal) satisfies any tighter binding under
 *   covariance.
 *
 * **Adopter extension surface.** The property walk is decomposed into
 * per-concern hooks so adopters customise a slice without copying it —
 * every hook receives the per-encode {@link EncodeContext}:
 * - {@link createEncodeContext} — widen the context with per-encode
 *   inputs, resolved once per entry.
 * - {@link propertyKeys} — which property names the walk visits.
 * - {@link shouldEmitProperty} — per-key filter on top of the default
 *   `$`-internals strip.
 * - {@link resolvePropertyValue} — value substitution per property.
 * - {@link finalizeTransferNode} — post-decoration per encoded node.
 * - {@link toTransferValue} — recursion seam per property value. Override
 *   to special-case reference encoding or to drop specific value shapes.
 * Envelope-level seams:
 * - {@link toTransferDocument} — bundle root + diagnostics into the wire
 *   {@link TransferDocument} envelope. Override to filter / merge
 *   diagnostics from auxiliary sources or to project a synthesised root.
 * - {@link toTransferDiagnostic} — project a {@link TransferLspDiagnostic}
 *   (the framework validator's output) to {@link TDiagnostic}.
 */
export class TransferEncoder<
   // The map is intentionally unconstrained — adopters supply typed
   // overlays whose specific-key shapes don't structurally satisfy a
   // `Record<string, TransferElement>` index signature. `TransferTypeFor`
   // applies the per-key `extends TransferElement` check at lookup time.
   TTransferMap = Record<string, TransferElement>,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> {
   protected readonly tracer: Tracer;

   /**
    * Per-document cache of encoded transfer roots ({@link toTransferDocument}'s
    * `'full'` root). Internal — not part of the encoder's public surface.
    * Lets the data-server's fingerprint and emitted envelope share a single
    * encode walk within one build (both call `toTransferDocument`).
    *
    * Evicts on `DocumentState.Linked`, NOT the default `onUpdate`: the `'full'`
    * transfer root folds in the AST-extension computed properties, which resolve
    * against other documents, so it changes on *cascade* rebuilds where the
    * document's own text (and version) does not. `DocumentCache`'s `state` mode
    * evicts every document affected by a build (any state `>= Linked`), which
    * covers those cascade dependents; the default `onUpdate` mode evicts only
    * the directly-edited documents and would serve a stale root to dependents.
    */
   protected readonly rootCache: DocumentCache<string, unknown>;

   // The base reads three slots: `Tracer`, the `DocumentBuilder` the root
   // cache evicts from, and `AstReflection` for the `'grammar'` allowlist. The
   // whole bundle is taken anyway, matching the framework's
   // `(services, options)` constructor convention, so a subclass needing a
   // further slot — a language `Serializer` for textual re-serialisation, say —
   // forwards the same parameter via `super(services, options)`.
   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: LogNameOptions = {}
   ) {
      this.tracer = services.Tracer.for(options.logName ?? 'TransferEncoder').trace('instantiated');
      this.rootCache = new DocumentCache<string, unknown>(services, DocumentState.Linked);
   }

   /**
    * Cache key for a memoised transfer root, *within* one document — the
    * {@link rootCache} is keyed `(document uri, this key)`.
    *
    * Default: the encode mode alone. That is correct exactly while the encoded
    * output is a pure function of `(document, mode)`, which holds for every
    * framework hook.
    *
    * **Adopters whose `createEncodeContext` injects an input that changes the
    * OUTPUT must fold that input in here.** Otherwise two encodes of one
    * document under different inputs serve each other's result: the first
    * caller's root is memoised and the second gets it back, silently, with no
    * type error to catch it. Widening the key is cheap (the cache holds one
    * entry per distinct key per document) and evicts on the same build
    * boundary.
    */
   protected rootCacheKey(context: EncodeContext): string {
      return context.mode;
   }

   /**
    * Encode an AST node into its transfer-model shape, resolving
    * cross-references to their `$refText` and recursing into nested nodes.
    * The {@link TransferMode} argument selects which properties are emitted;
    * {@link propertyKeys} enumerates them and the per-key hooks filter and
    * substitute.
    *
    * Non-destructive: returns a fresh object graph and leaves the AST
    * untouched. Synchronous — walks the in-memory AST without serialising.
    */
   toTransfer<T extends AstNode>(ast: T, mode: TransferMode = 'full'): TransferTypeFor<T, TTransferMap> {
      // Derive the owning document's URI when the node is attached so hooks
      // (and adopter-widened contexts) can resolve per-document inputs even
      // through this bare-node door. `findRootNode` never throws; a detached
      // or synthetic subtree simply yields an undefined URI.
      const uri = AstUtils.findRootNode(ast).$document?.uri.toString();
      return this.encodeNode(ast, this.createEncodeContext(mode, uri)) as TransferTypeFor<T, TTransferMap>;
   }

   /**
    * Create the {@link EncodeContext} for one encode entry. Called once per
    * entry point ({@link toTransfer}, {@link toTransferDocument},
    * {@link astDocumentToTransferDocument}); the result threads unchanged
    * through the whole recursion. Adopters override with a covariant return
    * type to carry extra per-encode inputs, resolved here once instead of
    * once per node.
    */
   protected createEncodeContext(mode: TransferMode, uri?: string): EncodeContext {
      return { mode, uri };
   }

   /**
    * Encode one node under an established context — the recursion core the
    * entry points and {@link toTransferValue} share. Delegates each concern to
    * an overridable hook so adopters customise a slice without copying the
    * walk.
    */
   protected encodeNode(ast: AstNode, context: EncodeContext): Record<string, unknown> {
      const result: Record<string, unknown> = { $type: ast.$type };
      for (const key of this.propertyKeys(ast, context)) {
         if (!this.shouldEmitProperty(ast, key, context)) {
            continue;
         }
         const value = this.resolvePropertyValue(ast, key, context);
         // `'grammar'` lists every declared property, including those absent on
         // this node; skip the absent ones. (`'full'` enumerates only own
         // properties, so absent properties never surface there.) Part of the
         // mode contract, not the adopter filter — hence not in shouldEmitProperty.
         if (context.mode === 'grammar' && value === undefined) {
            continue;
         }
         result[key] = this.toTransferValue(value, context);
      }
      this.finalizeTransferNode(ast, result, context);
      return result;
   }

   /**
    * Which property names the walk visits for `ast`.
    *
    * Default: `'full'` enumerates own properties (including non-enumerable
    * ones via `Object.getOwnPropertyNames`, which catches
    * AST-extension-derived properties); `'grammar'` enumerates the
    * declared-property allowlist per
    * `AstReflection.getTypeMetaData($type).properties`.
    */
   protected propertyKeys(ast: AstNode, context: EncodeContext): readonly string[] {
      return context.mode === 'grammar'
         ? Object.keys(this.services.AstReflection.getTypeMetaData(ast.$type).properties)
         : Object.getOwnPropertyNames(ast);
   }

   /**
    * Per-key filter. Default: strip the `$`-prefixed Langium internals
    * (`$container`, `$cstNode`, `$containerProperty`, `$containerIndex`,
    * `$document`) that would otherwise form cycles `JSON.stringify` rejects
    * or carry server-internal data clients cannot use. Adopter overrides
    * refine ON TOP of the default (call `super.shouldEmitProperty` first).
    */
   protected shouldEmitProperty(_ast: AstNode, key: string, _context: EncodeContext): boolean {
      return !key.startsWith('$');
   }

   /**
    * Which value the walk emits under `key`. Default: the node's own value.
    * Override to substitute a derived value under a grammar property name.
    */
   protected resolvePropertyValue(ast: AstNode, key: string, _context: EncodeContext): unknown {
      return (ast as unknown as Record<string, unknown>)[key];
   }

   /**
    * Post-decoration hook, invoked once per encoded node after its property
    * walk. Default: no-op. Override to append synthesised wire-only fields —
    * gate on `context.mode === 'full'` when the addition must stay out of the
    * grammar (round-trippable) shape.
    */
   protected finalizeTransferNode(_ast: AstNode, _result: Record<string, unknown>, _context: EncodeContext): void {
      // Intentionally empty — adopter seam.
   }

   /**
    * Build a wire {@link TransferDocument} envelope from a built
    * {@link LangiumDocument}. The `'full'` root is served from the internal
    * {@link rootCache} (memoised per document until it next rebuilds), under
    * {@link rootCacheKey} — so the data-server's fingerprint and emitted
    * envelope share one encode walk within a build, while two encodes whose
    * contexts differ in an output-affecting way stay separate entries.
    * Diagnostics are projected fresh on every call (cheap, and they change
    * independently of the root — a cross-document reference flipping unresolved
    * bumps diagnostics while the root, encoding the ref as the same
    * `$refText`, does not).
    *
    * The context is created before the cache lookup, not inside the factory,
    * because the key is derived from it — so it costs one context construction
    * per call, including on a hit. That is a shallow object plus whatever the
    * adopter resolves in `createEncodeContext`, against a whole encode walk
    * saved.
    *
    * The cache holds its entries as `unknown`, so the memoised root is
    * asserted to the caller's `<TAst>` claim on the way out. Nothing checks
    * that claim — Langium types `parseResult.value` as a bare `AstNode` — but
    * the runtime walk doesn't depend on the typing being correct.
    */
   toTransferDocument<TAst extends AstNode>(
      langiumDocument: LangiumDocument
   ): TransferDocument<TransferTypeFor<TAst, TTransferMap>, TDiagnostic> {
      const context = this.createEncodeContext('full', langiumDocument.uri.toString());
      const root = this.rootCache.get(langiumDocument.uri, this.rootCacheKey(context), () =>
         this.encodeNode(langiumDocument.parseResult.value, context)
      ) as TransferTypeFor<TAst, TTransferMap>;
      return this.assembleTransferDocument<TAst>(
         {
            uri: langiumDocument.textDocument.uri,
            version: langiumDocument.textDocument.version,
            diagnostics: langiumDocument.diagnostics ?? []
         },
         root
      );
   }

   /**
    * Wrap an already-encoded root into the wire envelope (uri / version /
    * projected diagnostics).
    *
    * **The single chokepoint for every envelope the encoder emits.** Both
    * document paths land here — {@link toTransferDocument} from a live
    * `LangiumDocument` and {@link astDocumentToTransferDocument} from an
    * `AstDocument` snapshot — so one override is seen by data-server emissions
    * and adopter facade returns alike. It takes a
    * {@link TransferEnvelopeSource} rather than a `LangiumDocument` precisely
    * so the snapshot path can reach it without a `LangiumDocuments` lookup.
    */
   protected assembleTransferDocument<TAst extends AstNode>(
      source: TransferEnvelopeSource<TDiagnostic>,
      root: TransferTypeFor<TAst, TTransferMap>
   ): TransferDocument<TransferTypeFor<TAst, TTransferMap>, TDiagnostic> {
      return {
         uri: source.uri,
         version: source.version,
         root,
         diagnostics: source.diagnostics.map(diagnostic => this.toTransferDiagnostic(diagnostic as TransferLspDiagnostic))
      };
   }

   /**
    * Build a wire {@link TransferDocument} envelope from a server-internal
    * {@link AstDocument} snapshot (the AST-typed envelope emitted by
    * `AstDocumentManager.onUpdate` / `onSave` and returned from
    * `ModelService.request` / `update` / `save`). Distinct from
    * {@link toTransferDocument}(`LangiumDocument`) which encodes against
    * the live build artifact — adopter facade returns hold the snapshot
    * directly, and this helper bridges that to the wire shape without a
    * second `LangiumDocuments.getDocument` lookup.
    *
    * The `diagnostic` projection assumes the snapshot's diagnostics carry
    * the `TransferLspDiagnostic` shape ({@link Diagnostic} plus the
    * framework validator's `element` / `property` decoration). Snapshots
    * built from raw Langium diagnostics structurally satisfy this — the
    * extra fields are optional in the projection.
    *
    * Encodes the root, then delegates the envelope to
    * {@link assembleTransferDocument} (an `AstDocument` satisfies
    * {@link TransferEnvelopeSource} structurally), so this path shares the
    * assembly seam rather than duplicating it.
    */
   astDocumentToTransferDocument<TAst extends AstNode>(
      document: AstDocument<TAst, TDiagnostic | TransferLspDiagnostic>
   ): TransferDocument<TransferTypeFor<TAst, TTransferMap>, TDiagnostic> {
      const root = this.encodeNode(document.root, this.createEncodeContext('full', document.uri)) as TransferTypeFor<TAst, TTransferMap>;
      return this.assembleTransferDocument<TAst>(document, root);
   }

   /**
    * Project an LSP-shaped diagnostic (typically a
    * {@link TransferLspDiagnostic} produced by
    * `HydraniumDocumentValidator` — adds `element` + optional `property`
    * to the standard {@link Diagnostic} shape) to the wire-diagnostic
    * shape.
    *
    * Default projection produces the full {@link TransferDiagnostic}: maps
    * LSP severity enum to the wire string union, discriminates the
    * diagnostic type from Langium's `data.code` (`'lexing-error'` /
    * `'parsing-error'` else `'validation-error'`), passes through
    * message / element / property / code. Adopters whose validator
    * doesn't decorate diagnostics with `element` still get a valid
    * `TransferDiagnostic` — the field falls back to `''`.
    *
    * Override only if the wire-diagnostic shape needs fields beyond
    * what {@link TransferDiagnostic} carries.
    */
   toTransferDiagnostic(diagnostic: TransferLspDiagnostic): TDiagnostic {
      const langiumCode = (diagnostic.data as { code?: string } | undefined)?.code;
      const result: TransferDiagnostic = {
         type: langiumCode === 'lexing-error' ? 'lexing-error' : langiumCode === 'parsing-error' ? 'parsing-error' : 'validation-error',
         element: diagnostic.element ?? '',
         property: diagnostic.property,
         // LSP 3.18 allows a `MarkupContent` message; the wire shape is plain text.
         message: Diagnostic.getMessageString(diagnostic),
         severity:
            diagnostic.severity === DiagnosticSeverity.Error
               ? 'error'
               : diagnostic.severity === DiagnosticSeverity.Warning
                 ? 'warning'
                 : 'info',
         code: typeof diagnostic.code === 'number' || typeof diagnostic.code === 'string' ? diagnostic.code : langiumCode
      };
      return result as TDiagnostic;
   }

   /**
    * Recursion seam — converts a single property value during the AST
    * walk. Arrays recurse element-wise; cross-references collapse to
    * their `$refText`; nested AST nodes encode via {@link encodeNode} under
    * the same {@link EncodeContext}; primitives pass through unchanged.
    */
   protected toTransferValue(value: unknown, context: EncodeContext): unknown {
      if (Array.isArray(value)) {
         return value.map(element => this.toTransferValue(element, context));
      }
      if (isReference(value)) {
         return value.$refText;
      }
      if (isAstNode(value)) {
         return this.encodeNode(value, context);
      }
      return value;
   }
}
