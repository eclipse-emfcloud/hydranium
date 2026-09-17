/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   DataConnection,
   DataEvents,
   type DataServerDiagnosticsProtocol,
   type DataServerProtocol,
   type ResolvedMessage,
   type TransferElement
} from '@hydranium/protocol';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
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
 */
@injectable()
export class OrderFlowDataConnection {
   @inject(OrderFlowTheiaDataPort) protected readonly port!: OrderFlowTheiaDataPort;

   protected connection!: DataConnection<OrderFlowTransferRoot, OrderFlowDataServer>;
   readonly events = new DataEvents<OrderFlowTransferRoot>();

   @postConstruct()
   protected init(): void {
      this.connection = new DataConnection<OrderFlowTransferRoot, OrderFlowDataServer>(this.port, this.events);
   }

   /** Mint a participant. `clientId` must be distinct per participant and stable. */
   createSession(clientId: string): ReturnType<DataConnection<OrderFlowTransferRoot, OrderFlowDataServer>['createSession']> {
      return this.connection.createSession(clientId);
   }

   /** Surface a failure the way the host does — the port's sink, shared by every participant. */
   reportError(error: unknown, reported: ResolvedMessage): void {
      this.port.reportError(error, reported);
   }

   /** The ready proxy, for the methods that carry no `clientId`. */
   connected(): ReturnType<DataConnection<OrderFlowTransferRoot, OrderFlowDataServer>['connected']> {
      return this.connection.connected();
   }

   dispose(): void {
      this.connection.dispose();
      this.events.dispose();
   }
}
