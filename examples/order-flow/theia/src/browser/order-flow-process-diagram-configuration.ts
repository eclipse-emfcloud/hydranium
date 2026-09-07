/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ContainerConfiguration, ConsoleLogger, LogLevel, TYPES } from '@eclipse-glsp/client';
import { initializeOrderFlowProcessDiagramContainer } from '@hydranium/example-order-flow-client/lib/diagram/order-flow-process-diagram-module';
import { AbstractHydraniumGlspDiagramConfiguration, createGlspClientTheiaModule } from '@hydranium/glsp-client-theia/lib/browser';
import { type Container, ContainerModule } from '@theia/core/shared/inversify';
import { ORDER_FLOW_OUTPUT_CHANNEL, OrderFlowProcessDiagramLanguage } from '../common/order-flow-diagram-language';

/**
 * Mounts the host-agnostic `.process` diagram definition in Theia.
 *
 * Almost no work of its own, and the rest of this doc is the reason for the
 * little there is. The diagram itself — element types, model classes, views — is
 * `order-flow-client`'s `initializeOrderFlowProcessDiagramContainer`, shared
 * verbatim with the VS Code shell. All this class contributes is the Theia host
 * module beside it.
 *
 * **`createGlspClientTheiaModule` must be called from inside
 * `configureContainer`, not from the frontend module.** It rebinds tokens the
 * GLSP/Theia diagram modules that `initializeDiagramContainer` loads have
 * already bound — the action dispatcher, the diagram loader, the hidden-bounds
 * updater and the Theia GLSP message service. Contributed anywhere earlier,
 * those rebinds are the ones that get overwritten, silently, with no error and a
 * diagram that merely misbehaves.
 *
 * **Extends `AbstractHydraniumGlspDiagramConfiguration`, not upstream's
 * `GLSPDiagramConfiguration`.** Extending upstream compiles and appears to work,
 * but forfeits {@link propagateMarkersToProblemsView} — and order-flow has a
 * co-resident LSP publishing the same diagnostics over `publishDiagnostics`, so
 * the stock behaviour lists every error twice under two marker owners. The GLSP
 * copy is also open-diagram-scoped, so it is only ever the flickering duplicate
 * of the persistent LSP entry.
 */
export class OrderFlowProcessDiagramConfiguration extends AbstractHydraniumGlspDiagramConfiguration {
   diagramType: string = OrderFlowProcessDiagramLanguage.diagramType;

   /** The LSP head already publishes these diagnostics; see the class doc. */
   protected override propagateMarkersToProblemsView = false;

   configureContainer(container: Container, ...containerConfiguration: ContainerConfiguration): Container {
      return initializeOrderFlowProcessDiagramContainer(container, ...containerConfiguration, orderFlowProcessTheiaModule);
   }
}

/**
 * The Theia host bindings for a `.process` diagram container.
 *
 * The log THRESHOLD is not set here — it is a process-global applied once from
 * the frontend module via `logLevelPreference`, whereas this module is
 * instantiated per diagram container.
 *
 * `TYPES.ILogger` is rebound by hand because the framework offers no helper for
 * it; sprotty's default logger is otherwise silent about view-registration
 * failures, which are exactly the errors a diagram integration produces.
 */
const orderFlowProcessTheiaModule = new ContainerModule((bind, unbind, isBound, rebind) => {
   rebind(TYPES.ILogger).to(ConsoleLogger).inSingletonScope();
   rebind(TYPES.LogLevel).toConstantValue(LogLevel.warn);
   createGlspClientTheiaModule({ bind, unbind, isBound, rebind }, { channelLogger: { channelName: ORDER_FLOW_OUTPUT_CHANNEL } });
});
