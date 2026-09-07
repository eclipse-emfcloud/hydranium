/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CreateOperationHandler, OperationHandlerRegistry, type PaletteItem, ToolPaletteItemProvider } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import {
   PROCESS_EFFECT_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_TASK_NODE_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE
} from './order-flow-process-diagram-types.js';

/** One palette entry: the element type it creates, and the codicon it wears. */
interface ProcessPaletteTool {
   readonly elementTypeId: string;
   readonly icon: string;
}

/**
 * The palette, in the order a `.process` is built up: place the steps, connect
 * them, then describe what a step does.
 *
 * **A flat list, not groups.** GLSP's `DefaultToolPaletteItemProvider` returns
 * two fixed groups — "Nodes" for what a `CreateNodeOperation` makes, "Edges" for
 * what a `CreateEdgeOperation` makes — and the client renders any item with
 * `children` as a titled group. At this palette's size that is two header rows
 * over a handful of buttons, and it reads as an outline of an empty document
 * rather than a toolbox. Grouping earns its chrome once there are enough tools to
 * scan; below that the icons do the work the headers would.
 *
 * The icons are the other half of it. `PaletteItem` extends `LabeledAction`, so
 * `icon` is a codicon id the client renders in front of the label — and each one
 * is chosen to say what the tool makes rather than to decorate: a step, a branch
 * point, a direction, a field the step touches.
 *
 * Keyed by ELEMENT TYPE rather than by operation kind, which is what lets the
 * order and the icons be a statement about the language instead of about the
 * protocol.
 */
const PROCESS_PALETTE_TOOLS: readonly ProcessPaletteTool[] = [
   { elementTypeId: PROCESS_TASK_NODE_TYPE, icon: 'symbol-method' },
   { elementTypeId: PROCESS_GATEWAY_NODE_TYPE, icon: 'git-branch' },
   { elementTypeId: PROCESS_TRANSITION_EDGE_TYPE, icon: 'arrow-right' },
   // An effect reads or writes a `.domain` FIELD, which is what the icon names.
   { elementTypeId: PROCESS_EFFECT_TYPE, icon: 'symbol-field' }
];

/**
 * Builds the `.process` tool palette.
 *
 * Anything whose element type is not listed in {@link PROCESS_PALETTE_TOOLS} is
 * still offered, appended after the known tools without an icon, rather than
 * silently dropped: a create handler bound without a list entry would otherwise
 * disappear from the palette with nothing to say why, and a missing tool is much
 * harder to notice than an unstyled one.
 */
@injectable()
export class OrderFlowToolPaletteItemProvider extends ToolPaletteItemProvider {
   @inject(OperationHandlerRegistry) protected readonly operationHandlerRegistry!: OperationHandlerRegistry;

   getItems(): PaletteItem[] {
      const handlers = this.operationHandlerRegistry.getAll().filter(CreateOperationHandler.is);
      const known = PROCESS_PALETTE_TOOLS.map(tool => tool.elementTypeId);
      const listed = PROCESS_PALETTE_TOOLS.flatMap((tool, index) =>
         this.itemsFor(handlers, elementTypeId => elementTypeId === tool.elementTypeId, index, tool.icon)
      );
      const rest = this.itemsFor(handlers, elementTypeId => !known.includes(elementTypeId), PROCESS_PALETTE_TOOLS.length);
      return [...listed, ...rest];
   }

   /**
    * One palette item per trigger action whose element type `claims` accepts.
    *
    * A handler contributes one action per entry in `elementTypeIds`, and the
    * item's label is the handler's — which is why each flow-node kind has a
    * handler of its own rather than one handler declaring both types.
    *
    * `sortString` carries the list POSITION rather than the label, because the
    * client sorts by it: ordering by the words would put the gateway before the
    * task it branches on, which is an accident of the alphabet.
    */
   protected itemsFor(
      handlers: CreateOperationHandler[],
      claims: (elementTypeId: string) => boolean,
      position: number,
      icon?: string
   ): PaletteItem[] {
      return handlers.flatMap(handler =>
         handler
            .getTriggerActions()
            .filter(action => claims(action.elementTypeId))
            .map(action => ({
               id: `palette-item-${action.elementTypeId}`,
               label: handler.label,
               actions: [action],
               sortString: String.fromCharCode(65 + position),
               ...(icon ? { icon } : {})
            }))
      );
   }
}
