/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type JsonModelState } from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { isPromiseLike, type MaybePromise } from '@hydranium/protocol';
import { AbstractHydraniumGlspState } from './abstract-hydranium-glsp-state.js';

/** Whole-document-text source model: the serialised text of the source root. */
export interface FullTextSourceModel {
   text: string;
}

/**
 * Editable GLSP state for adopters whose source model is the **whole document
 * text** — the source root serialised to its textual form, round-tripped by
 * re-parsing. The simplest of the framework source-model strategies (the others
 * project a structured transfer model, over one document or several), and the
 * natural starting point for a new adopter.
 *
 * Fully generic — both seams resolve through shared services, so adopters add
 * nothing beyond narrowing `TRoot` and their index:
 * - {@link sourceModel} serialises the source root through the per-URI
 *   `serializer.Serializer` reached via `sharedServices.ServiceRegistry`
 *   (so multi-grammar workspaces route to the right serializer). `MaybePromise`
 *   because serialization may be async; the sync fast path is preserved.
 * - {@link updateSourceModel} pushes the text back through
 *   `ModelService.update` (which accepts a raw text payload) and captures the
 *   re-parsed root.
 *
 * No `baseline` / conflict reconcile: a whole-document model has exactly one
 * field, so every concurrent edit is a same-field collision and undo / redo
 * degrade to drop-on-divergence. Adopters that need field-level undo use
 * `ReconcilingTransferHydraniumGlspState` instead.
 */
@injectable()
export class FullTextHydraniumGlspState<TRoot extends AstNode>
   extends AbstractHydraniumGlspState<TRoot, FullTextSourceModel>
   implements JsonModelState<FullTextSourceModel>
{
   get sourceModel(): MaybePromise<FullTextSourceModel> {
      const serializer = this.sharedServices.ServiceRegistry.getServices(URI.parse(this._sourceUri)).serializer.Serializer;
      const text = serializer.serializeAst(this._sourceRoot);
      return isPromiseLike(text) ? text.then(value => ({ text: value })) : { text };
   }

   async updateSourceModel(model: FullTextSourceModel): Promise<void> {
      const document = await this.sharedServices.model.ModelService.update({
         uri: this._sourceUri,
         model: model.text,
         clientId: this.clientId
      });
      this.setSourceRoot(this._sourceUri, document.root as TRoot);
   }
}
