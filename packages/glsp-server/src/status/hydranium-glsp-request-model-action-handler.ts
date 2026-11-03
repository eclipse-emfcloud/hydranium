/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ModelState, type ProgressMonitor, RequestModelActionHandler } from '@eclipse-glsp/server';
import { type ServerSharedServices } from '@hydranium/core';
import { defineMessage } from '@hydranium/protocol';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { type AstNode } from '@hydranium/langium';
import { inject, injectable } from 'inversify';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { DiagramStatus } from '../state/diagram-status.js';

export const DIAGRAM_LOADING = defineMessage('hydranium/glsp-server/diagram-loading', 'Loading diagram...');

/**
 * Reports model loading as {@link DiagramStatus.MODEL_LOAD} rather than
 * writing the client's status overlay directly, whose closing clear would
 * erase a status set while the model loaded.
 *
 * The status is withdrawn on a failed load as well: GLSP rethrows from
 * `handleModelLoadingError` before it reports the load finished, which would
 * leave the loading message standing.
 */
@injectable()
export class HydraniumGlspRequestModelActionHandler extends RequestModelActionHandler {
   @inject(ModelState) declare protected modelState: AbstractHydraniumGlspState<AstNode, unknown>;

   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   protected override reportModelLoading(_message: string): ProgressMonitor | undefined {
      const message = this.sharedServices.MessageRenderer.renderMessage(DIAGRAM_LOADING);
      this.modelState.setStatus(DiagramStatus.MODEL_LOAD, { message, severity: 'INFO' });
      return this.progressService.start(message);
   }

   protected override reportModelLoadingFinished(monitor?: ProgressMonitor): void {
      this.modelState.setStatus(DiagramStatus.MODEL_LOAD, undefined);
      monitor?.end();
   }

   protected override handleModelLoadingError(error: unknown, monitor?: ProgressMonitor): void {
      this.modelState.setStatus(DiagramStatus.MODEL_LOAD, undefined);
      super.handleModelLoadingError(error, monitor);
   }
}
