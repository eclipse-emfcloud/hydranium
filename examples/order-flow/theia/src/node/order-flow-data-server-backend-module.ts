/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createDataServerConnectionContainerModule } from '@hydranium/data-client-theia/lib/node';
import { OrderFlowDataServerConnectionHandler } from './order-flow-data-server-connection-handler';

// One handler, because the frontend opens one channel: every consumer of the
// data head takes a session off the one connection rather than a path of its
// own.
export default createDataServerConnectionContainerModule(OrderFlowDataServerConnectionHandler);
