/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { bindMemoryDiagnostics, MemoryDiagnosticsService } from '@hydranium/client-theia/lib/browser';
import { bindHostDiagnostics } from '@hydranium/data-client-theia/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { OrderFlowDataConnection } from './order-flow-data-connection';
import { OrderFlowMemoryDiagnostics } from './order-flow-memory-diagnostics';
import { OrderFlowTheiaDataPort } from './order-flow-theia-data-port';

/**
 * Wires the framework's parameterised `MemoryDiagnosticsContribution` into the
 * shell: binds the example's diagnostics frontend as the service (so "Dump
 * Server State" / "Write Heap Snapshot" / the profiling commands reach the real
 * model store over RPC) and registers the branded commands.
 *
 * **The whole adopter cost is this file** — the behaviour, the output-channel
 * formatting and the command set all live in `@hydranium/client-theia`; only the
 * three branding strings and the choice of service vary. That is the point worth
 * copying: an adopter does not write diagnostics commands, it names them.
 *
 * A separate `theiaExtensions` entry from the panel and the diagram, because it
 * is separately loadable: diagnostics need only the data head, so a deployment
 * can take these commands without a properties view or a diagram. The shared
 * connection is therefore bound here too, guarded, rather than owned by the
 * panel's entry.
 */
export default new ContainerModule((bind, _unbind, isBound) => {
   // Guarded because the properties entry binds the same two, and either
   // module may be loaded alone or beside the other.
   if (!isBound(OrderFlowTheiaDataPort)) {
      bind(OrderFlowTheiaDataPort).toSelf().inSingletonScope();
      bind(OrderFlowDataConnection).toSelf().inSingletonScope();
   }
   bind(OrderFlowMemoryDiagnostics).toSelf().inSingletonScope();
   bind(MemoryDiagnosticsService).toService(OrderFlowMemoryDiagnostics);
   bindMemoryDiagnostics(bind, {
      commandIdPrefix: 'order-flow',
      category: 'Order Flow',
      channelName: 'Order Flow Memory'
   });
   // Host (Theia backend) diagnostics proxy — adds "Dump Backend State" /
   // "Write Heap Snapshot (Backend)" to the contribution. Served by
   // order-flow-host-diagnostics-backend-module in the Theia backend process,
   // which is a DIFFERENT process from the data-server child the commands above
   // reach: without it those two commands are simply not registered.
   bindHostDiagnostics(bind);
});
