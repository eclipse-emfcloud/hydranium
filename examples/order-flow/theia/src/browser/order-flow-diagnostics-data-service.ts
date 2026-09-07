/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractDiagnosticsDataServiceFrontend } from '@hydranium/data-client-theia/lib/browser';
import { DATA_SERVER_WIRE_PREFIX, type DataServerDiagnosticsProtocol } from '@hydranium/protocol';
import { type ServiceConnectionProvider } from '@theia/core/lib/browser';
import { RemoteConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { ORDER_FLOW_DATA_DIAGNOSTICS_PATH } from '../common/order-flow-diagram-language';

/**
 * The slice of the data-server protocol this frontend proxies — the diagnostics
 * methods plus the readiness gate the framework base awaits.
 */
type DiagnosticsServer = DataServerDiagnosticsProtocol & { waitForReady(): Promise<void> };

/**
 * Exposes the data head's diagnostics surface to the frontend, so the framework's
 * `MemoryDiagnosticsContribution` commands reach the real model store over RPC.
 *
 * **Why this is a second connection to the same server.** The properties panel
 * reaches the data head through {@link OrderFlowTheiaDataPort}, a bare
 * {@link DataPort} the host-neutral `DataSession` drives; this class is a Theia
 * `AbstractDataServiceFrontend`, which owns its own channel and readiness. They
 * are two different abstractions over one wire because they answer to two
 * different consumers — the panel's stack is shared verbatim with the VS Code
 * shell and must stay host-neutral, while the diagnostics commands are Theia
 * `CommandContribution`s that never run anywhere else. Collapsing them would
 * mean either giving the neutral session a Theia dependency or reimplementing
 * six readiness-gated pass-throughs by hand.
 *
 * **It therefore needs its OWN service path, and this is the part that was
 * wrong.** Two connections are fine; two connections on one path are not.
 * Theia keys a frontend channel by its service path and refuses a second
 * channel on a path already open, so while this class sat on the framework
 * default it raced the panel's port and broke whichever opened second — and the
 * throw escaped the `openChannelConnection` the loser was awaiting, leaving that
 * promise unsettled instead of rejected. The properties panel showed `Loading…`
 * indefinitely, the server log was clean, and the only trace was a single
 * unread page error. {@link ORDER_FLOW_DATA_DIAGNOSTICS_PATH} is the fix; the
 * backend registers a forwarder for it beside the default one.
 *
 * An adopter that already ships a model-service frontend over the data head
 * binds *that* to `MemoryDiagnosticsService` instead and writes none of this:
 * the methods are identical, so a component that already extends
 * `AbstractDiagnosticsDataServiceFrontend` for its own model surface is
 * already the diagnostics service.
 *
 * The client is empty and `clientMethods` is empty because diagnostics is
 * request/response only — nothing here subscribes to a document.
 */
@injectable()
export class OrderFlowDiagnosticsDataService extends AbstractDiagnosticsDataServiceFrontend<DiagnosticsServer, Record<string, never>> {
   @inject(RemoteConnectionProvider) protected readonly connectionProvider: ServiceConnectionProvider;
   @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService;
   protected readonly client: Record<string, never> = {};
   protected readonly servicePath = ORDER_FLOW_DATA_DIAGNOSTICS_PATH;
   protected readonly methodNamespace = DATA_SERVER_WIRE_PREFIX;
   protected readonly clientMethods: readonly string[] = [];

   @postConstruct()
   protected init(): void {
      this.start();
   }
}
