/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GlspServerConnectionHandler } from '@hydranium/glsp-client-theia/lib/node';
import { injectable } from '@theia/core/shared/inversify';
import { ORDER_FLOW_DIAGRAM_LANGUAGE_ID, ORDER_FLOW_HOST_PORT_COMMANDS } from '../common/order-flow-diagram-language';

/** Bridges the frontend's GLSP channel to the server's GLSP socket. The
 *  framework base owns port discovery and the byte relay; only the two ids
 *  vary. Note the port command is the HOST command the VS Code extension
 *  registers, not the LSP request id. */
@injectable()
export class OrderFlowGlspConnectionHandler extends GlspServerConnectionHandler {
   constructor() {
      super({
         languageContributionId: ORDER_FLOW_DIAGRAM_LANGUAGE_ID,
         portCommand: ORDER_FLOW_HOST_PORT_COMMANDS.glsp
      });
   }
}
