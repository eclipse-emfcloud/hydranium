/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ClientSession } from '@hydranium/core';
import { type MultiDocumentSourceModel, ReconcilingMultiDocumentGlspState } from '@hydranium/glsp-server';
import { type AstNode, URI } from '@hydranium/langium';
import { type TransferElement } from '@hydranium/protocol';
import { injectable } from 'inversify';
import { LayoutModel, type ProcessModel, isLayoutModel } from '../language-server/ast.js';
import { layoutNode } from '../language-server/order-flow-ast-builder.js';
import { layoutUriFor } from '../language-server/layout-file.js';
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

/**
 * `order-flow`'s GLSP state, over the framework's
 * {@link ReconcilingMultiDocumentGlspState}.
 *
 * **The `.process` file is the PRIMARY and the `.layout` file is a secondary.**
 * The process is the document the user reasons about, and keeping it primary is
 * what lets every semantic operation handler go on mutating `sourceRoot`
 * unchanged. Which file the editor *opens* is a client concern; the GLSP source
 * URI is a server choice. A create-node operation writes both files, and the
 * base class writes them all or none, so a layout entry never names a flow node
 * the process file does not have.
 *
 * The layout file is located by **sibling convention** (`fulfillment.process` →
 * `fulfillment.layout`, see {@link layoutUriFor}), which is also how the
 * layout's entries find their process. The convention is deterministic, which
 * matters because the file may not exist yet — the first drag on a
 * never-laid-out process has to CREATE it, and that needs a name rather than a
 * search result. The diagram's session creates it ({@link openForWrite}), since
 * a session's writes open nothing.
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
    * The layout AST for this process — the loaded `.layout` document's root,
    * or an empty in-memory one when that file does not exist yet — read
    * through {@link workingRootOf}, so a handler edits the operation's copy of
    * either and an edit the operation drops stays out of both.
    *
    * **Never `undefined`, and that is load-bearing rather than convenience.** An
    * operation handler edits this root and the recording command derives
    * its patch from the before / after `sourceModel` projections. If a
    * never-laid-out process had no layout root, the first drag would have nothing
    * to mutate, the projection would be absent in both snapshots, and the patch
    * would come out EMPTY — the bounds would be silently dropped with no error
    * anywhere. Materialising an empty root instead means the first write is an
    * ordinary "document went from empty to one entry" diff, and
    * {@link openForWrite} creates the file before that diff is written.
    */
   get layoutRoot(): LayoutModel {
      const root = this.workingRootOf(this.layoutUri, () => this.builtLayoutRoot());
      return isLayoutModel(root) ? root : this.builtLayoutRoot();
   }

   /** The loaded `.layout` document's root, or the in-memory one while that file does not exist. */
   protected builtLayoutRoot(): LayoutModel {
      const loaded = this.sharedServices.model.ModelService.getDocument(this.layoutUri)?.parseResult?.value;
      if (isLayoutModel(loaded)) {
         // A real document supersedes the placeholder, so a later drag edits
         // the document's root rather than a stale in-memory stand-in for it.
         this.pendingLayoutRoot = undefined;
         return loaded;
      }
      return (this.pendingLayoutRoot ??= this.createLayoutRoot());
   }

   /** An empty layout root for this process. */
   protected createLayoutRoot(): LayoutModel {
      return layoutNode(LayoutModel, { nodes: [] });
   }

   protected override trackWriteSet(uri: string): void {
      this.trackSecondaryDocument(layoutUriFor(uri));
   }

   /**
    * Project the layout secondary from the operation's copy of it or
    * {@link builtLayoutRoot}, rather than from the document store, so a
    * not-yet-created `.layout` contributes an empty layout to the snapshot
    * instead of being omitted. Every other URI keeps the base behaviour.
    */
   protected override projectDocument(uri: string): TransferElement | undefined {
      return uri === this.layoutUri
         ? this.projectRoot(this.existingWorkingRootOf(uri) ?? this.capturedRootOf(uri) ?? this.builtLayoutRoot())
         : super.projectDocument(uri);
   }

   /**
    * Create the layout file, holding an empty layout, when the write set
    * reaches a process that has none; every other document is opened as the
    * base class opens it.
    *
    * Created EMPTY rather than with the layout being written, so the write
    * itself still goes through the base class's all-or-none write with the
    * process file, based on the version {@link createSecondaryDocument} records for the
    * created layout. When the create fails, because a file the workspace has
    * not read exists or another client created the layout first, the layout is
    * opened instead, and the write, based on the version recorded while the
    * layout did not exist, conflicts and is replayed onto that layout's text.
    */
   protected override async openForWrite(session: ClientSession<AstNode>, uri: string): Promise<void> {
      if (uri !== this.layoutUri || this.sharedServices.model.ModelService.getDocument(uri)) {
         return super.openForWrite(session, uri);
      }
      const serializer = this.sharedServices.ServiceRegistry.getServices(URI.parse(uri)).serializer.Serializer;
      // Outside the `try`: only a failed create means the layout may exist.
      const text = await serializer.serializeTransfer(this.projectRoot(this.createLayoutRoot()));
      try {
         await this.createSecondaryDocument(session, uri, text);
      } catch {
         await super.openForWrite(session, uri);
      }
   }
}
