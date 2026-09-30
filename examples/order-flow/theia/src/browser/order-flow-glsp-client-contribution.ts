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
import { ORDER_FLOW_DIAGRAM_LANGUAGE_ID } from '../common/order-flow-diagram-language';

/**
 * Pins this shell's GLSP contribution id.
 *
 * Deliberately the thin wrapper it looks like: the id is the only per-adopter
 * part of the arrangement, so anything more here means the base is being
 * worked around rather than configured.
 */
@injectable()
export class OrderFlowGlspClientContribution extends HydraniumGlspClientContribution {
   constructor() {
      super({ languageContributionId: ORDER_FLOW_DIAGRAM_LANGUAGE_ID });
   }
}
