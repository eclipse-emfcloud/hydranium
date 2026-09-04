/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Thrown by `AbstractHydraniumGlspState.ready` when the wait for a document
 * build state exceeds `AbstractHydraniumGlspState.readyTimeoutMs`. A dedicated
 * error class so callers can distinguish a genuine hang from other failures
 * via `instanceof`.
 *
 * The optional `diagnostic` carries a build-status snapshot so a captured log
 * line is self-explanatory without correlating the timeout entry against
 * earlier rebuild traces. `AbstractHydraniumGlspState.buildReadyTimeoutError`
 * fills it from the document builder; a caller constructing the error directly
 * may leave it empty.
 */
export class ModelReadyTimeoutError extends Error {
   constructor(
      public readonly uri: string,
      public readonly targetState: string,
      public readonly elapsedMs: number,
      public readonly diagnostic: string = ''
   ) {
      const suffix = diagnostic ? ` ${diagnostic}` : '';
      super(`Timed out after ${elapsedMs}ms waiting for state '${targetState}' on ${uri}.${suffix}`);
      this.name = 'ModelReadyTimeoutError';
   }
}
