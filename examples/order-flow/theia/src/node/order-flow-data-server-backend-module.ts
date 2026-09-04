/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createDataServerConnectionContainerModule } from '@hydranium/data-client-theia/lib/node';
import {
   OrderFlowDataServerConnectionHandler,
   OrderFlowDiagnosticsDataConnectionHandler
} from './order-flow-data-server-connection-handler';

// One handler per SERVICE PATH, both forwarding to the same data server: the
// properties panel's host-neutral port on the framework default, and the
// memory-diagnostics frontend on its own. Theia refuses a second channel on a
// path already open, so this is a requirement rather than a tidy split.
export default createDataServerConnectionContainerModule(OrderFlowDataServerConnectionHandler, OrderFlowDiagnosticsDataConnectionHandler);
