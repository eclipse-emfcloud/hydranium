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
import { hasSkippedText } from '@hydranium/core';
import { type BaseVersion, DocumentSyntaxError, isConflictError, isPromiseLike, type MaybePromise } from '@hydranium/protocol';
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
 *   (so multi-grammar workspaces route to the right serializer), keeping the
 *   document's comments. `MaybePromise` because serialization may be async;
 *   the sync fast path is preserved.
 * - {@link updateSourceModel} pushes the text back through the diagram's
 *   session (`update` accepts a raw text payload) and captures the re-parsed
 *   root, gated on the caller's `baseVersion`; it throws without a session.
 *
 * No `base` / conflict reconcile: a whole-document model has exactly one
 * field, so every concurrent edit is a same-field collision and undo / redo
 * degrade to drop-on-divergence, unless the text already holds what they
 * write. Adopters that need field-level undo use
 * `ReconcilingTransferHydraniumGlspState` instead.
 */
@injectable()
export class FullTextHydraniumGlspState<TRoot extends AstNode>
   extends AbstractHydraniumGlspState<TRoot, FullTextSourceModel>
   implements JsonModelState<FullTextSourceModel>
{
   /**
    * The source root serialised, with the comments of the built document the
    * captured root was parsed from re-attached through the language's trivia
    * service, as a structured write's text gets them. The serializer emits
    * none, so without them every write, undo and redo would delete them.
    */
   get sourceModel(): MaybePromise<FullTextSourceModel> {
      const uri = URI.parse(this._sourceUri);
      const services = this.sharedServices.ServiceRegistry.getServices(uri);
      const trivia = services.trivia?.TriviaService;
      const document = this._sourceRoot.$document;
      const extracted = trivia !== undefined && document !== undefined ? trivia.extract(document) : undefined;
      const withTrivia = (text: string): FullTextSourceModel => ({
         text: trivia !== undefined && extracted !== undefined ? trivia.apply(text, extracted, uri) : text
      });
      const text = services.serializer.Serializer.serializeAst(this.sourceRoot);
      return isPromiseLike(text) ? text.then(withTrivia) : withTrivia(text);
   }

   /**
    * A write that conflicts while the store already holds `model.text`, as
    * when an undo's side effect brought the text to the undo's result, is
    * taken as applied; any other conflict is thrown.
    *
    * The session writes text without the parse check a model write gets.
    * Once a source that does not parse is built, {@link sourceModel}
    * serializes the recovered root, and writing it deletes what the parser
    * skipped. So this throws `DocumentSyntaxError` while the parse of the
    * source's last build lacks some of its text. Until that build lands, the
    * state holds the last clean root at its version, so a write from it
    * conflicts.
    */
   async updateSourceModel(model: FullTextSourceModel, baseVersion: BaseVersion = this.baseVersion): Promise<void> {
      const built = this.sharedServices.model.ModelService.getDocument(this._sourceUri);
      if (built !== undefined && hasSkippedText(built)) {
         throw new DocumentSyntaxError(this._sourceUri);
      }
      let document: { root: AstNode };
      try {
         document = await this.requireModelSession().update({ uri: this._sourceUri, model: model.text, baseVersion });
      } catch (error: unknown) {
         if (isConflictError(error) && this.sharedServices.workspace.TextDocuments.get(this._sourceUri)?.getText() === model.text) {
            this.logger.debug(
               `updateSourceModel already applied (model v${error.baseVersion} / text v${error.actualVersion}); the document already holds the diagram edit`
            );
            this.captureBuiltRoot();
            return;
         }
         throw error;
      }
      this.captureWrittenRoot(document.root as TRoot);
   }
}
