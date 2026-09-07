/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
   ActionHandlerConstructor,
   BindingTarget,
   DiagramConfiguration,
   GModelFactory,
   GModelIndex,
   InstanceMultiBinding,
   ModelState,
   ModelSubmissionHandler,
   ModelValidator,
   OperationHandlerConstructor,
   EdgeCreationChecker,
   SourceModelStorage,
   ToolPaletteItemProvider
} from '@eclipse-glsp/server';
import { ComputedBoundsActionHandler } from '@eclipse-glsp/server';
import type { LanguageMetaData } from '@hydranium/langium';
import {
   HydraniumGlspComputedBoundsActionHandler,
   AbstractHydraniumGlspDiagramModule,
   HydraniumGlspModelValidator
} from '@hydranium/glsp-server';
import { OrderFlowApplyLabelEditOperationHandler } from './handler/apply-label-edit-operation-handler.js';
import { OrderFlowChangeBoundsOperationHandler } from './handler/change-bounds-operation-handler.js';
import { OrderFlowCreateEffectOperationHandler } from './handler/create-effect-operation-handler.js';
import {
   OrderFlowCreateGatewayOperationHandler,
   OrderFlowCreateTaskOperationHandler
} from './handler/create-flow-node-operation-handler.js';
import { OrderFlowCreateTransitionOperationHandler } from './handler/create-transition-operation-handler.js';
import { OrderFlowDeleteElementOperationHandler } from './handler/delete-element-operation-handler.js';
import { OrderFlowEdgeCreationChecker } from './order-flow-edge-creation-checker.js';
import { ProcessLanguageMetaData } from '../language-server/generated/module.js';
import { OrderFlowGlspIndex } from './order-flow-glsp-index.js';
import { OrderFlowGlspState } from './order-flow-glsp-state.js';
import { OrderFlowGlspStorage } from './order-flow-glsp-storage.js';
import { OrderFlowProcessDiagramConfiguration } from './order-flow-process-diagram-configuration.js';
import { PROCESS_DIAGRAM_TYPE } from './order-flow-process-diagram-types.js';
import { OrderFlowProcessGModelFactory } from './order-flow-process-gmodel-factory.js';
import { OrderFlowSubmissionHandler } from './order-flow-submission-handler.js';
import { OrderFlowToolPaletteItemProvider } from './order-flow-tool-palette-item-provider.js';

/**
 * The `.process` diagram type — the **editable** slice.
 *
 * The operation handlers, the framework computed-bounds handler and the
 * interactive type hints are one set rather than three independent choices: each
 * is useless or actively misleading without the others, because a hint declaring
 * a capability with no handler produces a palette tool whose operation the server
 * rejects.
 *
 * **`declareLanguage` is the multi-grammar seam.** It binds the grammar this
 * diagram edits on the SESSION container, so `modelState.diagramLanguage` and
 * the `scopeProviderFor` / `candidateProviderFor` lookups resolve to
 * `.process`. In a two-grammar adopter that is what stops a diagram type from
 * fighting over one process-wide binding — `.domain` has no diagram, but it is
 * registered on the same server, so the binding has to be per-session rather
 * than global.
 */
export class OrderFlowProcessDiagramModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType = PROCESS_DIAGRAM_TYPE;

   protected override declareLanguage(): LanguageMetaData {
      return ProcessLanguageMetaData;
   }

   protected override bindModelState(): BindingTarget<ModelState> {
      return { service: OrderFlowGlspState };
   }

   protected override bindGModelIndex(): BindingTarget<GModelIndex> {
      return { service: OrderFlowGlspIndex };
   }

   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return OrderFlowGlspStorage;
   }

   protected override bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
      return OrderFlowProcessDiagramConfiguration;
   }

   protected override bindGModelFactory(): BindingTarget<GModelFactory> {
      return OrderFlowProcessGModelFactory;
   }

   protected override bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler> {
      return OrderFlowSubmissionHandler;
   }

   /**
    * Order and ICON the tool palette by element kind rather than taking GLSP's
    * two fixed operation-kind groups; see {@link OrderFlowToolPaletteItemProvider}.
    */
   protected override bindToolPaletteItemProvider(): BindingTarget<ToolPaletteItemProvider> {
      return OrderFlowToolPaletteItemProvider;
   }

   /**
    * Answer the client's per-hover question about an edge being drawn.
    *
    * Like the model validator, GLSP leaves this binding **optional** and
    * defaults it to nothing — and unlike the validator, leaving it out is not
    * merely silent but actively misleading once a hint is marked `dynamic`: the
    * client would ask and get no checker, so every target reads as allowed right
    * up to the drop that discards the operation. The binding and the `dynamic`
    * flag in `OrderFlowProcessDiagramConfiguration` belong together.
    */
   protected override bindEdgeCreationChecker(): BindingTarget<EdgeCreationChecker> {
      return OrderFlowEdgeCreationChecker;
   }

   /**
    * Surface the language server's diagnostics as diagram markers.
    *
    * The framework class unmodified, and it is the only one of these bindings
    * that GLSP leaves **optional**: `DiagramModule.bindModelValidator()` returns
    * `undefined` by default and `HydraniumGlspStorage` injects the slot
    * `@optional()`, so leaving it out is not an error — it is a diagram that
    * silently never shows a marker, with no log line to say so.
    *
    * Binding it turns on two paths at once. The tool-palette validate command
    * gets a `ModelValidator` to ask, and the framework storage's
    * `refreshDiagnosticMarkers` starts pushing a `SetMarkersAction` after every
    * rebuild that reaches `Validated`, so markers follow a text edit live
    * instead of waiting for the user to re-validate.
    *
    * No subclass, unlike {@link OrderFlowGlspState} / {@link OrderFlowGlspIndex} /
    * {@link OrderFlowGlspStorage}: the framework validator resolves a
    * diagnostic's `element` path through the `AstNodeLocator` of whichever
    * language owns the document it was published on, which is exactly what a
    * multi-grammar adopter needs. What it cannot supply itself is which GModel
    * element stands for a foreign AST node — that is the GModel factory's
    * `registerElementId` half; see
    * {@link OrderFlowProcessGModelFactory.registerEffectTarget}.
    */
   protected override bindModelValidator(): BindingTarget<ModelValidator> {
      return HydraniumGlspModelValidator;
   }

   /**
    * Substitute the framework computed-bounds handler for GLSP's default.
    *
    * **`rebind`, not `add`.** GLSP's `configureActionHandlers` already registers
    * `ComputedBoundsActionHandler`, and its dispatcher executes *every* handler
    * registered for an action kind. Appending ours would leave both live —
    * and because the computed-bounds path calls `submitModelDirectly`, which
    * does not bump the model revision, the second handler's revision check
    * still passes: bounds get applied twice and the client receives two
    * submissions per layout pass. Worse, upstream's unfiltered `applyRoute`
    * would run first, so the framework override's under-routed-edge filter —
    * the whole reason it exists, preventing `GLSPServerError: Invalid Route!` —
    * would never get the chance to act.
    *
    * What the substitution buys: revision mismatches during the initial
    * `requestModel → setModel` handshake are logged as warnings instead of
    * silently returning `[]`, which is the difference between a diagnosable
    * and an invisible "model loading…" hang.
    */
   protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
      super.configureActionHandlers(binding);
      binding.rebind(ComputedBoundsActionHandler, HydraniumGlspComputedBoundsActionHandler);
   }

   /**
    * The editable surface: create a flow node or a transition, add an effect,
    * delete any of them, edit a name or a branch label in place, and move or
    * resize a node.
    *
    * `add` rather than `rebind` for all of these, unlike the computed-bounds
    * action handler: GLSP's base registers no operation handler for these
    * operation types, so there is no default to displace. The
    * `OperationHandlerRegistry` also differs from the action registry in
    * resolving ONE handler per operation rather than running every match, so a
    * duplicate would shadow rather than double-apply.
    */
   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      // One handler per flow-node kind, because the palette takes its label from
      // the handler: a single handler serving both element types renders as the
      // same entry twice.
      binding.add(OrderFlowCreateTaskOperationHandler);
      binding.add(OrderFlowCreateGatewayOperationHandler);
      binding.add(OrderFlowCreateTransitionOperationHandler);
      binding.add(OrderFlowCreateEffectOperationHandler);
      binding.add(OrderFlowDeleteElementOperationHandler);
      binding.add(OrderFlowApplyLabelEditOperationHandler);
      binding.add(OrderFlowChangeBoundsOperationHandler);
   }
}
