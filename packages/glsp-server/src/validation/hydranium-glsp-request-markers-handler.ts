/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, MarkersReason, type RequestMarkersAction, RequestMarkersHandler, SetMarkersAction } from '@eclipse-glsp/server';
import { injectable } from 'inversify';

/**
 * Answers a batch {@link RequestMarkersAction}, such as the palette's Validate,
 * as GLSP's {@link RequestMarkersHandler} does, then sends the live set again.
 * Answers a request for another reason under that reason, where GLSP's handler
 * labels every answer batch, so a live request does not add a batch copy of
 * the live set.
 *
 * `HydraniumGlspModelValidator` answers a batch request with no markers, since
 * the client shows each reason's set beside the other and a batch copy of the
 * live set would list every issue twice. The live set this handler adds makes
 * Validate repaint what the server knows, which repairs a live set a cancelled
 * build left stale. A caller that awaits the request gets the batch set, as
 * from GLSP's handler. A validator that answers both reasons with the same
 * markers still lists each issue twice after Validate.
 *
 * `AbstractHydraniumGlspDiagramModule` registers it in place of GLSP's. A
 * diagram module that does not extend that base rebinds it in
 * `configureActionHandlers`. Without it Validate shows no markers and repairs
 * nothing.
 */
@injectable()
export class HydraniumGlspRequestMarkersHandler extends RequestMarkersHandler {
   override async execute(action: RequestMarkersAction): Promise<Action[]> {
      const reason = action.reason ?? MarkersReason.BATCH;
      const answer = (await super.execute(action)).map(sent => (SetMarkersAction.is(sent) ? { ...sent, reason } : sent));
      if (reason !== MarkersReason.BATCH) {
         return answer;
      }
      const live = await this.validator.validate([this.modelState.root], MarkersReason.LIVE);
      return [...answer, SetMarkersAction.create(live, { reason: MarkersReason.LIVE })];
   }
}
