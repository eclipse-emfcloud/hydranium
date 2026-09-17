/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DataServerConnectionHandler } from '@hydranium/data-client-theia/lib/node';
import { injectable } from '@theia/core/shared/inversify';
import { ORDER_FLOW_HOST_PORT_COMMANDS } from '../common/order-flow-diagram-language';

/**
 * Bridges the frontend's data channel to the model server's TCP socket.
 *
 * The service path keeps the framework default `DATA_SERVER_PATH`, which
 * `OrderFlowTheiaDataPort` opens a channel against. The port command does NOT
 * keep its default: the order-flow extension registers its own host command id
 * rather than the framework's `hydranium/data-server/port`, so a handler left on
 * the default would poll a command nobody registers — and poll forever, since
 * `findPortAttempts` defaults to `-1`.
 */
@injectable()
export class OrderFlowDataServerConnectionHandler extends DataServerConnectionHandler {
   constructor() {
      super({ portCommand: ORDER_FLOW_HOST_PORT_COMMANDS.dataServer });
   }
}
