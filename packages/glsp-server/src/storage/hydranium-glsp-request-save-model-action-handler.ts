/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, SaveModelAction, SaveModelActionHandler } from '@eclipse-glsp/server';
import { ModelSavedAction, RequestSaveModelAction } from '@hydranium/protocol';
import { injectable } from 'inversify';

/**
 * Answers a {@link RequestSaveModelAction}: saves exactly as GLSP's
 * {@link SaveModelActionHandler} saves a `SaveModelAction` carrying the same
 * `fileUri`, dirty-state change included, then replies with a
 * {@link ModelSavedAction}.
 *
 * A failed save throws, and the server turns the throw into a `RejectAction`
 * for the request. The save handler's own `SaveModelAction` stays registered,
 * so a client that sends it is unaffected.
 *
 * `AbstractHydraniumGlspDiagramModule` registers it. A diagram module that does
 * not extend that base adds it in `configureActionHandlers`. Without it no
 * handler is advertised for the request, and the Theia client saves as GLSP's
 * saveable does: a save nothing answers, so a failed one surfaces only as a
 * timeout, and a window can close over a save still under way.
 */
@injectable()
export class HydraniumGlspRequestSaveModelActionHandler extends SaveModelActionHandler {
   override actionKinds = [RequestSaveModelAction.KIND];

   // Typed `Action`, the one parameter type both this kind and the base's accept.
   override async execute(action: Action): Promise<Action[]> {
      const fileUri = 'fileUri' in action && typeof action.fileUri === 'string' ? action.fileUri : undefined;
      const actions = await super.execute(SaveModelAction.create({ fileUri }));
      return [...actions, ModelSavedAction.create()];
   }
}
