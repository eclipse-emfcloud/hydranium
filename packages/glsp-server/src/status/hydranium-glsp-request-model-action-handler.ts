/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ModelState, type ProgressMonitor, RequestModelActionHandler } from '@eclipse-glsp/server';
import { type AstNode } from '@hydranium/langium';
import { inject, injectable } from 'inversify';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { DiagramStatus } from '../state/diagram-status.js';

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

   protected override reportModelLoading(message: string): ProgressMonitor | undefined {
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
