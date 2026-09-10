/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type MultiDocumentSourceModel, ReconcilingMultiDocumentGlspState } from '@hydranium/glsp-server';
import { type TransferElement } from '@hydranium/protocol';
import { injectable } from 'inversify';
import { LayoutModel, type ProcessModel, isLayoutModel } from '../language-server/ast.js';
import { layoutNode } from '../language-server/order-flow-ast-builder.js';
import type { ProcessModel as TransferProcessModel } from '../language-server/generated-hydranium/transfer-model.js';
import type { OrderFlowGlspIndex } from './order-flow-glsp-index.js';

/**
 * GLSP source-model shape: the `.process` projection as the PRIMARY document,
 * plus the `.layout` layout file as a secondary.
 *
 * Field-level rather than whole-document text, which is what lets
 * `fast-json-patch` record per-field patches across BOTH documents at once:
 * undo / redo and forward-write reconcile act per field instead of clobbering
 * either file.
 */
export type OrderFlowSourceModel = MultiDocumentSourceModel<TransferProcessModel>;

/** The layout file for a process document: same basename, `.layout` extension. */
export function layoutUriFor(processUri: string): string {
   return processUri.replace(/\.process$/, '.layout');
}

/**
 * `order-flow`'s GLSP state, over the framework's
 * {@link ReconcilingMultiDocumentGlspState}.
 *
 * **The `.process` file is the PRIMARY and the `.layout` file is a secondary,
 * which is the inverse of the framework default's assumed shape — and that is
 * deliberate, because it is the case the base class documents as needing an
 * override.** The semantics are what layout REFERENCES, and the write rule is
 * referenced-before-referencing, so this state writes the primary FIRST. Left at
 * the default (secondaries first) a create-node operation would write a layout
 * entry naming a flow node that does not exist yet, producing a linking error in
 * the `.layout` file until the second write landed. Inverting it means a partial
 * write leaves a flow node with no layout entry instead: inert, invisible to
 * every non-diagram consumer, and repaired by the next drag.
 *
 * Why the `.process` file and not the `.layout` file is primary: the process is
 * the document the user reasons about and the one whose version the conflict gate
 * should guard, and keeping it primary is what lets every semantic operation
 * handler go on mutating `sourceRoot` unchanged. Which file the editor *opens* is
 * a client concern; the GLSP source URI is a server choice.
 *
 * The layout file is located by **sibling convention** (`fulfillment.process` →
 * `fulfillment.layout`) rather than by searching the index for a `LayoutModel`
 * pointing back at this process. The convention is deterministic, which matters
 * because the file may not exist yet — the first drag on a never-laid-out process
 * has to CREATE it, and that needs a name rather than a search result.
 * `ModelService.update` is an upsert, so writing a URI with nothing on disk
 * creates it.
 */
@injectable()
export class OrderFlowGlspState extends ReconcilingMultiDocumentGlspState<ProcessModel, TransferProcessModel> {
   declare readonly index: OrderFlowGlspIndex;

   /** URI of this process's layout file, whether or not it exists yet. */
   get layoutUri(): string {
      return layoutUriFor(this.sourceUri);
   }

   /**
    * Layout root held in memory for a process whose `.layout` file does not
    * exist yet. Discarded as soon as a real document appears at that URI.
    */
   protected pendingLayoutRoot?: LayoutModel;

   /**
    * The layout AST for this process — the loaded `.layout` document's root, or
    * an empty in-memory one when that file does not exist yet.
    *
    * **Never `undefined`, and that is load-bearing rather than convenience.** An
    * operation handler mutates the AST in place and the recording command derives
    * its patch from the before / after `sourceModel` projections. If a
    * never-laid-out process had no layout root, the first drag would have nothing
    * to mutate, the projection would be absent in both snapshots, and the patch
    * would come out EMPTY — the bounds would be silently dropped with no error
    * anywhere. Materialising an empty root instead means the first write is an
    * ordinary "document went from empty to one entry" diff, and
    * `ModelService.update` (an upsert) creates the file.
    */
   get layoutRoot(): LayoutModel {
      const loaded = this.sharedServices.model.ModelService.getDocument(this.layoutUri)?.parseResult?.value;
      if (isLayoutModel(loaded)) {
         // A real document supersedes the placeholder, so a later drag mutates
         // the parsed root rather than a stale in-memory copy of it.
         this.pendingLayoutRoot = undefined;
         return loaded;
      }
      this.pendingLayoutRoot ??= this.createLayoutRoot();
      return this.pendingLayoutRoot;
   }

   /**
    * An empty layout root for this process. `name` is derived from the process
    * name so the generated file reads like a hand-authored one, and `process` is
    * a bare reference to the process root — the grammar's `layout X for Y` header
    * needs both before any entry can be serialized.
    */
   protected createLayoutRoot(): LayoutModel {
      const process = this.languageServicesFor(this.sourceRoot)?.references.ReferenceBuilder.toOwnReference(this.sourceRoot);
      return layoutNode(LayoutModel, {
         name: `${this.sourceRoot.name}Layout`,
         process: process as LayoutModel['process'],
         nodes: []
      });
   }

   protected override trackWriteSet(uri: string): void {
      this.trackSecondaryDocument(layoutUriFor(uri));
   }

   /**
    * Project the layout secondary from {@link layoutRoot} rather than from the
    * document store, so a not-yet-created `.layout` contributes an empty layout
    * to the snapshot instead of being omitted. Every other URI keeps the base
    * behaviour.
    */
   protected override projectDocument(uri: string): TransferElement | undefined {
      return uri === this.layoutUri ? this.projectRoot(this.layoutRoot) : super.projectDocument(uri);
   }

   /**
    * Primary (semantics) first, then secondaries (layout) — the inverse of the
    * base order, for the reason on the class doc: layout references semantics, so
    * semantics has to land first for a partial write to be inert rather than
    * dangling.
    *
    * Keeps the base class's `hasChanged` guard on both sides, and it matters most
    * here: a pure drag changes only the layout, and writing the `.process` file
    * anyway would re-serialize it — reformatting effects onto separate lines and
    * dropping every comment in the file. A move must not touch the semantics at
    * all, which is the whole reason layout was split out.
    */
   protected override async persist(model: OrderFlowSourceModel, baseVersion?: number): Promise<{ root: ProcessModel }> {
      const result = this.hasChanged(this.baseline?.primary, model.primary)
         ? await this.persistPrimary(model.primary, baseVersion)
         : { root: this.sourceRoot };
      for (const [uri, secondary] of Object.entries(model.secondaries)) {
         if (this.hasChanged(this.baseline?.secondaries[uri], secondary)) {
            await this.persistSecondary(uri, secondary as TransferElement);
         }
      }
      return result;
   }
}
