/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, GLSPServerError, type Logger, RequestAction } from '@eclipse-glsp/server';
import { type ConflictError, describeError, describeErrorWithStack, isConflictError, isDocumentSyntaxError } from '@hydranium/protocol';

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
 * A diagram edit's write the reconcile could not settle, so nothing was written,
 * thrown as a subclass naming the reason. Its message is shown to the user, so
 * it carries no error code. `conflict` is the last conflict a write raised.
 */
export abstract class DiagramWriteUnsettledError extends GLSPServerError {
   constructor(
      message: string,
      readonly conflict: ConflictError
   ) {
      super(message, conflict);
   }
}

/**
 * Whether `error` is a {@link DiagramWriteRanOutError} or a
 * {@link DiagramTextUnreadableError}, by name, as {@link isDiagramEditDroppedError} checks.
 */
export function isDiagramWriteUnsettledError(error: unknown): error is DiagramWriteUnsettledError {
   return isDiagramWriteRanOutError(error) || isDiagramTextUnreadableError(error);
}

/**
 * Thrown when a diagram edit's writes ran out: each one conflicted, because
 * another writer kept changing the document. A retry may land.
 */
export class DiagramWriteRanOutError extends DiagramWriteUnsettledError {
   constructor(message: string, conflict: ConflictError) {
      super(message, conflict);
      this.name = 'DiagramWriteRanOutError';
   }
}

/** Whether `error` is a {@link DiagramWriteRanOutError}, by name, as {@link isDiagramEditDroppedError} checks. */
export function isDiagramWriteRanOutError(error: unknown): error is DiagramWriteRanOutError {
   return error instanceof Error && error.name === 'DiagramWriteRanOutError';
}

/**
 * Thrown when a diagram edit's write conflicted and the document's current
 * text could not be read to reconcile it against: forcing the edit would
 * overwrite text the diagram never saw.
 */
export class DiagramTextUnreadableError extends DiagramWriteUnsettledError {
   constructor(message: string, conflict: ConflictError) {
      super(message, conflict);
      this.name = 'DiagramTextUnreadableError';
   }
}

/** Whether `error` is a {@link DiagramTextUnreadableError}, by name, as {@link isDiagramEditDroppedError} checks. */
export function isDiagramTextUnreadableError(error: unknown): error is DiagramTextUnreadableError {
   return error instanceof Error && error.name === 'DiagramTextUnreadableError';
}

/**
 * Log an action that failed, once, at the level of what happened. A dropped
 * edit logs at `debug`, since its reconcile has logged it. A refused write logs
 * at `warn`, since it was declined: a conflict, writes that ran out, a text
 * that could not be read, or a document that does not parse. Anything else
 * logs at `error`. Every line that has a conflict, the failure's own or its
 * cause's, names the conflict's versions. A request is named by its id too,
 * which its client's reject carries.
 */
export function logActionFailure(logger: Logger, action: Action, error: unknown): void {
   const named = `'${action.kind}'${RequestAction.is(action) ? ` (${action.requestId})` : ''}`;
   if (isDiagramEditDroppedError(error)) {
      logger.debug(`Could not process action ${named}: ${describeError(error)}`);
   } else if (isConflictError(error)) {
      logger.warn(
         `Could not process action ${named}: ${describeError(error)} (model v${error.baseVersion} / text v${error.actualVersion})`
      );
   } else if (isDiagramWriteUnsettledError(error)) {
      // Its message is the user's, which names no document.
      const { conflict } = error;
      logger.warn(
         `Could not process action ${named}: ${describeError(error)} (${conflict.uri}, model v${conflict.baseVersion} / text v${conflict.actualVersion})`
      );
   } else if (isDocumentSyntaxError(error)) {
      logger.warn(`Could not process action ${named}: ${describeError(error)}`);
   } else {
      const cause = error instanceof Error ? error.cause : undefined;
      const conflict = isDiagramWriteUnsettledError(cause) ? cause.conflict : isConflictError(cause) ? cause : undefined;
      const versions = conflict ? ` (model v${conflict.baseVersion} / text v${conflict.actualVersion})` : '';
      logger.error(`Could not process action ${named}${versions}: ${describeErrorWithStack(error)}`);
   }
}
