/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HostMemoryDiagnosticsService } from '@hydranium/client-theia/lib/browser';
import { HOST_DIAGNOSTICS_PATH, type HostDiagnosticsProtocol } from '@hydranium/protocol';
import { RemoteConnectionProvider, type ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { type interfaces } from '@theia/core/shared/inversify';

/**
 * Bind the host-process diagnostics frontend proxy to
 * {@link HostMemoryDiagnosticsService} so `MemoryDiagnosticsContribution`'s
 * "Dump Backend State" / "Write Heap Snapshot (Backend)" commands light up. The
 * proxy targets {@link HOST_DIAGNOSTICS_PATH}, served in the Theia backend by
 * `createHostDiagnosticsBackendModule` (see `../node`). Call from a Theia
 * frontend `ContainerModule`, alongside `bindMemoryDiagnostics`.
 */
export function bindHostDiagnostics(bind: interfaces.Bind): void {
   bind(HostMemoryDiagnosticsService)
      .toDynamicValue(context => {
         const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
         return provider.createProxy<HostDiagnosticsProtocol>(HOST_DIAGNOSTICS_PATH);
      })
      .inSingletonScope();
}
