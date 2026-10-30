/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, type Logger, RequestAction } from '@eclipse-glsp/server';
import { describeError, describeErrorWithStack, isConflictError, isDocumentSyntaxError } from '@hydranium/protocol';

/**
 * Thrown when the reconcile of a diagram edit's write dropped it: a foreign
 * edit changed a field the edit writes. Declined by design rather than failed,
 * and the reconcile has logged it, so whoever ends it tells the client without
 * logging it again. It never crosses a wire, so it carries no error code.
 */
export class DiagramEditDroppedError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'DiagramEditDroppedError';
   }
}

/**
 * Whether `error` is a {@link DiagramEditDroppedError}, by name, so one thrown
 * by another installed copy of this package counts too.
 */
export function isDiagramEditDroppedError(error: unknown): error is DiagramEditDroppedError {
   return error instanceof Error && error.name === 'DiagramEditDroppedError';
}

/**
 * Log an action that failed, once, at the level of what happened: a dropped
 * edit at `debug`, since its reconcile has logged it, a conflict at `warn`
 * naming its versions and a write to a document that does not parse at
 * `warn`, since both were declined, and anything else at `error`.
 * A request is named by its id too, which its client's reject carries.
 */
export function logActionFailure(logger: Logger, action: Action, error: unknown): void {
   const named = `'${action.kind}'${RequestAction.is(action) ? ` (${action.requestId})` : ''}`;
   if (isDiagramEditDroppedError(error)) {
      logger.debug(`Could not process action ${named}: ${describeError(error)}`);
   } else if (isConflictError(error)) {
      logger.warn(
         `Could not process action ${named}: ${describeError(error)} (model v${error.baseVersion} / text v${error.actualVersion})`
      );
   } else if (isDocumentSyntaxError(error)) {
      logger.warn(`Could not process action ${named}: ${describeError(error)}`);
   } else {
      logger.error(`Could not process action ${named}: ${describeErrorWithStack(error)}`);
   }
}
