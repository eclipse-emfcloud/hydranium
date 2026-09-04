/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractHydraniumGlspTheiaFrontendModule } from '@hydranium/glsp-client-theia/lib/browser';
import { ORDER_FLOW_LOG_LEVEL_PREFERENCE, OrderFlowProcessDiagramLanguage } from '../common/order-flow-diagram-language';
import { OrderFlowGlspClientContribution } from './order-flow-glsp-client-contribution';
import { OrderFlowProcessDiagramConfiguration } from './order-flow-process-diagram-configuration';
import { OrderFlowProcessDiagramManager } from './order-flow-process-diagram-manager';
// The shared sheet first, this shell's own second: how the diagram LOOKS belongs
// with the diagram module and is identical in every shell, while this package
// supplies only the `--theia-*` value behind each colour role. The later import
// has to be the one able to override.
import '@hydranium/example-order-flow-client/style/diagram.css';
import '../../style/order-flow-diagram.css';

/**
 * The `.process` diagram's Theia frontend extension.
 *
 * Everything mechanical — binding the configuration, registering the diagram
 * manager, wrapping the widget in the framework's loading overlay — comes from
 * `AbstractHydraniumGlspTheiaFrontendModule`. This subclass only names what
 * varies per adopter.
 */
export class OrderFlowProcessDiagramModule extends AbstractHydraniumGlspTheiaFrontendModule {
   readonly diagramLanguage = OrderFlowProcessDiagramLanguage;
   protected readonly diagramConfiguration = OrderFlowProcessDiagramConfiguration;
   protected readonly diagramManager = OrderFlowProcessDiagramManager;
   protected override readonly logLevelPreference = ORDER_FLOW_LOG_LEVEL_PREFERENCE;

   // The workspace-deferred start + ready-marker tail; see the contribution.
   protected override bindClientContribution(): typeof OrderFlowGlspClientContribution {
      return OrderFlowGlspClientContribution;
   }
}

export default new OrderFlowProcessDiagramModule();
