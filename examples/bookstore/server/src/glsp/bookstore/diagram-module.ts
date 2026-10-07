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
// model, so the starter create handler is what makes this diagram editable at all.

import type {
   ActionHandlerConstructor,
   BindingTarget,
   DiagramConfiguration,
   GModelFactory,
   GModelIndex,
   InstanceMultiBinding,
   ModelState,
   ModelSubmissionHandler,
   OperationHandlerConstructor,
   SourceModelStorage
} from '@eclipse-glsp/server';
import { ComputedBoundsActionHandler } from '@eclipse-glsp/server';
import { HydraniumGlspComputedBoundsActionHandler, AbstractHydraniumGlspDiagramModule, HydraniumGlspIndex } from '@hydranium/glsp-server';
import { BookstoreCreateNodeOperationHandler } from './create-node-operation-handler.js';
import { BookstoreDiagramConfiguration } from './diagram-configuration.js';
import { BookstoreGModelFactory } from './gmodel-factory.js';
import { BookstoreGlspState } from './state.js';
import { BookstoreGlspStorage } from './storage.js';
import { BookstoreSubmissionHandler } from './submission-handler.js';
import { BOOKSTORE_DIAGRAM_TYPE } from './types.js';

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

   protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
      super.configureActionHandlers(binding);
      binding.rebind(ComputedBoundsActionHandler, HydraniumGlspComputedBoundsActionHandler);
   }

   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(BookstoreCreateNodeOperationHandler);
   }
}
