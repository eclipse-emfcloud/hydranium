/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumGlspClientContribution } from '@hydranium/glsp-client-theia/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import {
   ORDER_FLOW_DIAGRAM_LANGUAGE_ID,
   ORDER_FLOW_GLSP_READY_MARKER,
   ORDER_FLOW_OUTPUT_CHANNEL
} from '../common/order-flow-diagram-language';

/**
 * Pins this shell's GLSP contribution id, Output channel and ready marker.
 *
 * The framework base supplies what a plugin-hosted server needs: it holds the
 * client back until a workspace is open, then tails the Output channel until the
 * server prints the ready marker. Without that, the client would try to connect
 * before the sideloaded VS Code extension has even launched the server.
 *
 * Deliberately the thin wrapper it looks like: these values are the only
 * per-adopter part of the arrangement, so anything more here means the base is
 * being worked around rather than configured.
 */
@injectable()
export class OrderFlowGlspClientContribution extends HydraniumGlspClientContribution {
   constructor() {
      super({
         languageContributionId: ORDER_FLOW_DIAGRAM_LANGUAGE_ID,
         channelName: ORDER_FLOW_OUTPUT_CHANNEL,
         readyMarker: ORDER_FLOW_GLSP_READY_MARKER
      });
   }
}
