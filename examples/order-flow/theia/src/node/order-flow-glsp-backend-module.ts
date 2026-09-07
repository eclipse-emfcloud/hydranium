/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createGlspConnectionContainerModule } from '@hydranium/glsp-client-theia/lib/node';
import { OrderFlowGlspConnectionHandler } from './order-flow-glsp-connection-handler';

export default createGlspConnectionContainerModule(OrderFlowGlspConnectionHandler);
