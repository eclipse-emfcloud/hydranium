/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type EndProgressAction, type StartProgressAction, type UpdateProgressAction } from '@eclipse-glsp/client';
import { TheiaGLSPMessageService } from '@eclipse-glsp/theia-integration';
import { type interfaces, injectable } from '@theia/core/shared/inversify';

/**
 * Title of the model-loading progress report. Emitted by
 * `@eclipse-glsp/server`'s `RequestModelActionHandler`, so it is a GLSP-protocol
 * constant every server shares, not an adopter string — which is what makes
 * matching on it a framework-level concern.
 *
 * Matched by title because `StartProgressAction` carries no kind or category to
 * key on; the `progressId` is generated per report, so it can only be correlated
 * after the fact (see {@link HydraniumGlspMessageService.suppressedProgressIds}).
 *
 * Matching an English literal fails silently — no error, no log line, just the
 * duplicate progress popup back — so this needs keeping in step with
 * `RequestModelActionHandler` on every GLSP bump.
 *
 * **Exported to be imported, and it must NOT be externalized.** An adopter
 * subclassing the message service needs the same literal to match on, and a
 * second copy of it is a second thing to keep in step across that bump. It is
 * also the one user-visible string in the framework that is deliberately excluded
 * from the message catalogue: it exists to equal an upstream English literal that
 * lives in no catalogue, so giving it a code and a translation would break the
 * match it exists for.
 */
export const MODEL_LOADING_PROGRESS_TITLE = 'Model loading in progress';

/**
 * Drops the Theia progress notification for diagram model loading, and only that
 * one.
 *
 * `HydraniumGlspDiagramWidget`'s loading overlay already reports model loading,
 * on the canvas the user is looking at; the notification says the same thing in a
 * corner popup. Every other progress report is forwarded untouched, so a
 * long-running server operation still surfaces normally.
 *
 * Bound unconditionally by `createGlspClientTheiaModule`, because the overlay it
 * defers to is likewise unconditional. A head that no-ops the overlay and wants
 * the notification back rebinds `TheiaGLSPMessageService` to GLSP's own.
 */
@injectable()
export class HydraniumGlspMessageService extends TheiaGLSPMessageService {
   /** Ids of reports that were swallowed, so their updates and completion are
    *  dropped as well — otherwise Theia sees an update for a progress it never
    *  started. */
   protected suppressedProgressIds = new Set<string>();

   protected override startProgress(action: StartProgressAction): void {
      if (action.title === MODEL_LOADING_PROGRESS_TITLE) {
         this.suppressedProgressIds.add(action.progressId);
         return;
      }
      super.startProgress(action);
   }

   protected override updateProgress(action: UpdateProgressAction): void {
      if (this.suppressedProgressIds.has(action.progressId)) {
         return;
      }
      super.updateProgress(action);
   }

   protected override endProgress(action: EndProgressAction): void {
      // `delete` reports whether the id was suppressed and cleans the entry up in
      // one step, so the set cannot grow across reloads.
      if (this.suppressedProgressIds.delete(action.progressId)) {
         return;
      }
      super.endProgress(action);
   }
}

/**
 * Replace the message service bound by GLSP's `theiaNotificationModule`.
 *
 * Called by `createGlspClientTheiaModule`, whose module the adopter registers
 * after the Theia default modules — so the token is normally already bound and
 * this rebinds. The `isBound` branch keeps it correct regardless of module order
 * and if GLSP's default composition changes: it degrades to "we bind it
 * ourselves" instead of an inversify error at diagram-open time.
 */
export function bindHydraniumGlspMessageService(bind: interfaces.Bind, isBound: interfaces.IsBound, rebind: interfaces.Rebind): void {
   if (isBound(TheiaGLSPMessageService)) {
      rebind(TheiaGLSPMessageService).to(HydraniumGlspMessageService).inSingletonScope();
   } else {
      bind(TheiaGLSPMessageService).to(HydraniumGlspMessageService).inSingletonScope();
   }
}
