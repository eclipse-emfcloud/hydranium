/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type ActionDispatcher,
   type ActionHandlerConstructor,
   applyBindingTarget,
   type BindingTarget,
   type ClientSessionInitializer,
   type CommandStack,
   DiagramModule,
   type InstanceMultiBinding,
   type MultiBinding,
   OperationActionHandler,
   RequestModelActionHandler,
   SetEditModeActionHandler,
   UndoRedoActionHandler
} from '@eclipse-glsp/server';
import { injectable, type interfaces } from 'inversify';
import { HydraniumGlspServerActionDispatcher } from '../dispatcher/server-action-dispatcher.js';
import { HydraniumGlspRequestSaveModelActionHandler } from '../storage/hydranium-glsp-request-save-model-action-handler.js';
import { HydraniumGlspCommandStack } from '../command/hydranium-glsp-command-stack.js';
import { HydraniumGlspOperationActionHandler } from '../command/hydranium-glsp-operation-action-handler.js';
import { HydraniumGlspUndoRedoActionHandler } from '../command/hydranium-glsp-undo-redo-action-handler.js';
import { DefaultDiagramStatusReporter, DiagramStatusReporter } from '../status/diagram-status-reporter.js';
import { HydraniumGlspRequestModelActionHandler } from '../status/hydranium-glsp-request-model-action-handler.js';
import { HydraniumGlspSetEditModeActionHandler } from '../status/hydranium-glsp-set-edit-mode-action-handler.js';

/**
 * GLSP {@link DiagramModule} base that wires the framework's diagram status,
 * dispatch timing, command stack, save, and transactional operation, undo and
 * redo handlers.
 *
 * A diagram module declares no grammar: a session's language is the one its
 * loaded document routes to, so one diagram type can serve several grammars.
 * Adopter GLSP components read `modelState.diagramLanguage` for a reference
 * written on the canvas and `modelState.languageServicesFor(node)` for
 * anything reached through a reference; see `HydraniumTypes` for why no
 * per-language service has a token of its own.
 *
 * An adopter whose diagram module already extends a base of its own repeats
 * what this class's overrides do. Without the status bindings among them,
 * nothing tells the client why its diagram is read-only; without the operation
 * and undo handlers, operation handlers edit the built root every reader
 * shares.
 */
@injectable()
export abstract class AbstractHydraniumGlspDiagramModule extends DiagramModule {
   protected override configure(
      bind: interfaces.Bind,
      unbind: interfaces.Unbind,
      isBound: interfaces.IsBound,
      rebind: interfaces.Rebind
   ): void {
      // Bound first: `super.configure` applies the session initializers, and the
      // reporter's initializer entry refers to this binding.
      applyBindingTarget({ bind, isBound }, DiagramStatusReporter, this.bindDiagramStatusReporter()).inSingletonScope();
      super.configure(bind, unbind, isBound, rebind);
   }

   /** The {@link DiagramStatusReporter} of the session; {@link DefaultDiagramStatusReporter} by default. */
   protected bindDiagramStatusReporter(): BindingTarget<DiagramStatusReporter> {
      return DefaultDiagramStatusReporter;
   }

   /** Starts the {@link DiagramStatusReporter} with the session, since nothing else injects it. */
   override configureClientSessionInitializers(binding: MultiBinding<ClientSessionInitializer>): void {
      super.configureClientSessionInitializers(binding);
      binding.add({ service: DiagramStatusReporter });
   }

   /** {@link HydraniumGlspServerActionDispatcher}, so every dispatch is timed once logging is at debug. */
   protected override bindActionDispatcher(): BindingTarget<ActionDispatcher> {
      return HydraniumGlspServerActionDispatcher;
   }

   /** {@link HydraniumGlspCommandStack}, so the diagram is dirty exactly while a document it has open is. */
   protected override bindCommandStack(): BindingTarget<CommandStack> {
      return HydraniumGlspCommandStack;
   }

   /**
    * Adds {@link HydraniumGlspRequestSaveModelActionHandler}, the save the
    * Theia client sends, beside GLSP's own save handler; replaces the GLSP
    * handlers that write the client's status or edit mode with ones that set a
    * diagram status instead; and runs operations, undo and redo through
    * {@link HydraniumGlspOperationActionHandler} and
    * {@link HydraniumGlspUndoRedoActionHandler}, without which handlers edit
    * the built root every reader shares.
    */
   protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
      super.configureActionHandlers(binding);
      binding.add(HydraniumGlspRequestSaveModelActionHandler);
      binding.rebind(RequestModelActionHandler, HydraniumGlspRequestModelActionHandler);
      binding.rebind(SetEditModeActionHandler, HydraniumGlspSetEditModeActionHandler);
      binding.rebind(OperationActionHandler, HydraniumGlspOperationActionHandler);
      binding.rebind(UndoRedoActionHandler, HydraniumGlspUndoRedoActionHandler);
   }
}
