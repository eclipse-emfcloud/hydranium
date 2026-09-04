/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractHydraniumGlspDiagramManager } from '@hydranium/glsp-client-theia/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import { OrderFlowProcessDiagramLanguage } from '../common/order-flow-diagram-language';

/** Opens `.process` files in the diagram editor. The framework base owns the
 *  widget factory and the Open-With registration; only the language and the
 *  editor label vary per adopter. */
@injectable()
export class OrderFlowProcessDiagramManager extends AbstractHydraniumGlspDiagramManager {
   static readonly ID = 'order-flow-process-diagram-manager';

   override get id(): string {
      return OrderFlowProcessDiagramManager.ID;
   }

   protected readonly diagramLanguage = OrderFlowProcessDiagramLanguage;
   protected readonly managerLabel = 'Order Flow Process Diagram Editor';
}
