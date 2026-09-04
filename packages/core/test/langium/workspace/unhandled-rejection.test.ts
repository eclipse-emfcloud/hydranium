/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { handleProcessUnhandledRejection } from '../../../src/langium/workspace/hydranium-workspace-manager.js';
import { makeNoopLogger } from '../../../src/testing/index.js';

/** Real no-op logger with its `error` method spied — the handler only ever calls `error`. */
function makeLogger(): { logger: ReturnType<typeof makeNoopLogger>; error: ReturnType<typeof vi.spyOn> } {
   const logger = makeNoopLogger();
   const error = vi.spyOn(logger, 'error');
   return { logger, error };
}

describe('handleProcessUnhandledRejection', () => {
   it('swallows Langium OperationCancelled without logging', () => {
      const { logger, error } = makeLogger();
      // The String() form is what Langium's internal cancellation marker produces.
      handleProcessUnhandledRejection(Symbol('OperationCancelled'), logger);
      expect(error).not.toHaveBeenCalled();
   });

   it('logs a non-cancellation Error so it is not silently dropped', () => {
      const { logger, error } = makeLogger();
      handleProcessUnhandledRejection(new Error('boom'), logger);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('boom');
   });

   it('logs a non-cancellation non-Error reason', () => {
      const { logger, error } = makeLogger();
      handleProcessUnhandledRejection('plain string reason', logger);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('plain string reason');
   });

   it('does not swallow an unrelated symbol that merely looks similar', () => {
      const { logger, error } = makeLogger();
      handleProcessUnhandledRejection(Symbol('SomethingElse'), logger);
      expect(error).toHaveBeenCalledTimes(1);
   });
});
