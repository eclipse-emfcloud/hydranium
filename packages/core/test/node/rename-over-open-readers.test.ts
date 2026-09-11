/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { RENAME_CONTENTION_CODES, renameOverOpenReaders } from '../../src/node/rename-over-open-readers.js';

/**
 * The retry is a WINDOWS behaviour with no Windows in it: contention is
 * simulated by a rename that fails on demand, so these run and discriminate on
 * every platform. Its only previous exercise was as a side effect of the
 * real-filesystem tearing test, which cannot produce a chosen errno, cannot
 * reach the budget deliberately, and only contends on one platform.
 */
describe('renameOverOpenReaders', () => {
   const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rigged`), { code });

   /** A rename that fails `times` times with `code`, then succeeds. */
   const failing = (times: number, code: string) => {
      let calls = 0;
      const rename = async (): Promise<void> => {
         calls++;
         if (calls <= times) {
            throw failure(code);
         }
      };
      return { rename, calls: () => calls };
   };

   for (const code of RENAME_CONTENTION_CODES) {
      it(`retries past a transient ${code} and resolves`, async () => {
         const stub = failing(2, code);
         await expect(renameOverOpenReaders('from', 'to', { rename: stub.rename, budgetMs: 1_000 })).resolves.toBeUndefined();
         expect(stub.calls()).toBe(3);
      });
   }

   it('rethrows the last failure once the budget is spent, rather than hanging', async () => {
      const stub = failing(Number.MAX_SAFE_INTEGER, 'EPERM');
      await expect(renameOverOpenReaders('from', 'to', { rename: stub.rename, budgetMs: 25 })).rejects.toThrow(/EPERM/);
      // More than one call is the whole claim: a budget that rethrew on the
      // first failure would pass a bare "it rejects" assertion.
      expect(stub.calls()).toBeGreaterThan(1);
   });

   it('rethrows an errno outside the contention set immediately', async () => {
      const stub = failing(Number.MAX_SAFE_INTEGER, 'ENOSPC');
      await expect(renameOverOpenReaders('from', 'to', { rename: stub.rename, budgetMs: 10_000 })).rejects.toThrow(/ENOSPC/);
      // Exactly one: a fault that will not clear must not be waited on, and a
      // 10s budget makes a retrying implementation obvious.
      expect(stub.calls()).toBe(1);
   });

   it('rethrows an error carrying no code immediately', async () => {
      let calls = 0;
      const rename = async (): Promise<void> => {
         calls++;
         throw new Error('no errno here');
      };
      await expect(renameOverOpenReaders('from', 'to', { rename, budgetMs: 10_000 })).rejects.toThrow(/no errno here/);
      expect(calls).toBe(1);
   });
});
