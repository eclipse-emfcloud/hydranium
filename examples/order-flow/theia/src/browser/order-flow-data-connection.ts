/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DataSessionStopContribution } from '@hydranium/data-client-theia/lib/browser';
import {
   DataConnectionWithEvents,
   type DataServerDiagnosticsProtocol,
   type DataServerProtocol,
   type TransferElement
} from '@hydranium/protocol';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable, type interfaces } from '@theia/core/shared/inversify';
import { OrderFlowTheiaDataPort } from './order-flow-theia-data-port';

/** The transfer root, left at the framework's bound: nothing here reads a typed property. */
type OrderFlowTransferRoot = TransferElement;

/**
 * Everything this frontend calls on the data head — the document surface the
 * panel uses, and the process diagnostics the commands use.
 *
 * Naming both on one protocol is what lets them share a connection: the
 * diagnostics methods carry no `clientId`, so they need no session of their own.
 */
export interface OrderFlowDataServer extends DataServerProtocol<OrderFlowTransferRoot>, DataServerDiagnosticsProtocol {}

/**
 * The frontend's single connection to the data head.
 *
 * Shared because Theia keys a frontend channel by its service path and refuses a
 * second on a path already open; the earlier arrangement gave the diagnostics
 * commands their own path to dodge that, which cost a second forwarder and a
 * second connection to the same server. Sessions are the supported way to have
 * more than one participant.
 *
 * **The whole adopter cost of the data head in Theia is this class and the
 * port.** The sessions, the event fan-out, the readiness gate, the reconnect
 * generation and the error sink all come from the framework.
 *
 * CONSTRUCTOR injection, not a `@postConstruct`: the connection takes its port
 * at construction, and a `@inject` field is filled afterwards — too late to pass
 * to `super`.
 */
@injectable()
export class OrderFlowDataConnection extends DataConnectionWithEvents<OrderFlowTransferRoot, OrderFlowDataServer> {
   constructor(@inject(OrderFlowTheiaDataPort) port: OrderFlowTheiaDataPort) {
      super(port);
   }
}

/**
 * Bind the connection and its port, unless an entry loaded earlier did: the
 * properties panel and the diagnostics commands share them, and either entry
 * may be loaded alone or beside the other.
 *
 * The stop contribution is bound with the connection and tracks it as it is
 * built, so every session the connection starts ends with the page. Bound
 * once, here, because a second binding per entry makes its lookup ambiguous.
 */
export function bindOrderFlowDataConnection(bind: interfaces.Bind, isBound: interfaces.IsBound): void {
   if (isBound(OrderFlowTheiaDataPort)) {
      return;
   }
   bind(OrderFlowTheiaDataPort).toSelf().inSingletonScope();
   bind(OrderFlowDataConnection)
      .toSelf()
      .inSingletonScope()
      .onActivation((context, connection) => {
         context.container.get(DataSessionStopContribution).track(connection);
         return connection;
      });
   bind(DataSessionStopContribution).toSelf().inSingletonScope();
   bind(FrontendApplicationContribution).toService(DataSessionStopContribution);
}
