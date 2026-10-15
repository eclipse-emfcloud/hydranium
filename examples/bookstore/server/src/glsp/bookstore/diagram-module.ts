/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// GLSP diagram module for Bookstore — the DI wiring of one diagram type.
//
// `configureActionHandlers` REBINDS rather than adds: GLSP's own
// `DiagramModule` already registers `ComputedBoundsActionHandler`, and two
// handlers for one action would both run.
//
// `configureOperationHandlers` ADDS: GLSP's default pair
// (`CompoundOperationHandler` and `LayoutOperationHandler`) mutates no source
// model, so the starter create and delete handlers are what make this diagram
// editable at all.

import type {
   ActionHandlerConstructor,
   BindingTarget,
   ComputedBoundsAction,
   DiagramConfiguration,
   GModelFactory,
   GModelIndex,
   GModelRoot,
   InstanceMultiBinding,
   ModelState,
   ModelSubmissionHandler,
   ModelValidator,
   OperationHandlerConstructor,
   SourceModelStorage
} from '@eclipse-glsp/server';
import { ComputedBoundsActionHandler } from '@eclipse-glsp/server';
import {
   HydraniumGlspComputedBoundsActionHandler,
   AbstractHydraniumGlspDiagramModule,
   HydraniumGlspIndex,
   HydraniumGlspModelValidator
} from '@hydranium/glsp-server';
import { BookstoreCreateNodeOperationHandler } from './create-node-operation-handler.js';
import { BookstoreDeleteOperationHandler } from './delete-operation-handler.js';
import { BookstoreDiagramConfiguration } from './diagram-configuration.js';
import { BookstoreGModelFactory } from './gmodel-factory.js';
import { BookstoreGlspState } from './state.js';
import { BookstoreGlspStorage } from './storage.js';
import { BookstoreSubmissionHandler } from './submission-handler.js';
import { BOOKSTORE_DIAGRAM_TYPE } from '@hydranium/bookstore-protocol';
import { injectable } from 'inversify';

/**
 * The framework handler, keeping none of the edge routes the client reports:
 * it routes an edge before it sizes the nodes, so a self-reference's loop would
 * stay drawn inside its node. The starter's edges have no routing points, and
 * the client routes them afresh from the sized nodes.
 */
@injectable()
export class BookstoreComputedBoundsActionHandler extends HydraniumGlspComputedBoundsActionHandler {
   protected override applyBounds(root: GModelRoot, action: ComputedBoundsAction): void {
      super.applyBounds(root, { ...action, routes: undefined });
   }
}

export class BookstoreDiagramModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType = BOOKSTORE_DIAGRAM_TYPE;

   protected override bindModelState(): BindingTarget<ModelState> {
      return { service: BookstoreGlspState };
   }

   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return { service: BookstoreGlspStorage };
   }

   protected override bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler> {
      return { service: BookstoreSubmissionHandler };
   }

   protected override bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
      return { service: BookstoreDiagramConfiguration };
   }

   protected override bindGModelFactory(): BindingTarget<GModelFactory> {
      return { service: BookstoreGModelFactory };
   }

   /** The framework index unmodified — it keys elements by name, with a positional fallback. */
   protected override bindGModelIndex(): BindingTarget<GModelIndex> {
      return { service: HydraniumGlspIndex };
   }

   /**
    * The language's diagnostics as diagram markers, following each edit. GLSP
    * binds no validator by default, and without one no marker ever shows.
    */
   protected override bindModelValidator(): BindingTarget<ModelValidator> {
      return HydraniumGlspModelValidator;
   }

   protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
      super.configureActionHandlers(binding);
      binding.rebind(ComputedBoundsActionHandler, BookstoreComputedBoundsActionHandler);
   }

   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(BookstoreCreateNodeOperationHandler);
      binding.add(BookstoreDeleteOperationHandler);
   }
}
