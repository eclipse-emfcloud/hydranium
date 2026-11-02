/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultWorkspaceLock } from '@hydranium/langium';
import { Deferred } from '@hydranium/protocol';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
   captureReadLockScope,
   createSynchronousReadLockScope,
   isInsideReadLock,
   type ReadLockMark,
   ReadLockWaitError,
   refuseWaitInRead,
   runInReadLockScope,
   setReadLockScope
} from '../../../src/langium/workspace/read-lock-scope.js';
import { installNodeReadLockScope } from '../../../src/node/write-lock-scope-node.js';

/** A read whose grace period the test ends by hand. */
function makeRead(): ReadLockMark & { endGrace(): void; end(): void } {
   const ended = new Deferred<void>();
   let refuse: (() => void) | undefined;
   const read = {
      running: true as boolean,
      ended: ended.promise,
      startGrace: (onEnd: () => void) => {
         refuse = onEnd;
         return { dispose: () => (refuse = undefined) };
      },
      endGrace: () => refuse?.(),
      end: () => {
         read.running = false;
         ended.resolve();
      }
   };
   return read;
}

describe('read-lock scope without async context', () => {
   beforeEach(() => setReadLockScope(createSynchronousReadLockScope()));
   afterAll(installNodeReadLockScope);

   it('marks a read only until its first await', async () => {
      const read = makeRead();
      const seen = await runInReadLockScope(async () => {
         const before = isInsideReadLock();
         await Promise.resolve();
         return [before, isInsideReadLock()];
      }, read);

      expect(seen).toEqual([true, false]);
      expect(isInsideReadLock()).toBe(false);
   });

   it('carries a captured read across an await', async () => {
      const read = makeRead();
      const inside = await runInReadLockScope(async () => {
         const inCallerRead = captureReadLockScope();
         await Promise.resolve();
         return inCallerRead(() => isInsideReadLock());
      }, read);

      expect(inside).toBe(true);
   });

   it('runs outside every read with no read given', () => {
      const read = makeRead();
      expect(runInReadLockScope(() => runInReadLockScope(() => isInsideReadLock(), undefined), read)).toBe(false);
   });
});

describe('refuseWaitInRead', () => {
   beforeEach(installNodeReadLockScope);
   // A read no lock ran, so the wait counts as one for this lock's work.
   const lock = new DefaultWorkspaceLock();

   it('rejects a wait still pending when the grace period ends', async () => {
      const read = makeRead();
      const refused = runInReadLockScope(() => refuseWaitInRead('A build', new Deferred<void>().promise, lock), read);
      read.endGrace();

      await expect(refused).rejects.toBeInstanceOf(ReadLockWaitError);
   });

   it('lets a wait go on once its read ends first', async () => {
      const read = makeRead();
      const waiting = new Deferred<string>();
      const result = runInReadLockScope(() => refuseWaitInRead('A build', waiting.promise, lock), read);
      read.end();
      await read.ended;
      read.endGrace();
      waiting.resolve('built');

      await expect(result).resolves.toBe('built');
   });

   it('passes the wait through outside a read', () => {
      const waiting = new Deferred<void>().promise;
      expect(refuseWaitInRead('A build', waiting, lock)).toBe(waiting);
   });
});
