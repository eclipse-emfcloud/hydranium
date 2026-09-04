/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { HydraniumWorkspaceLock } from '../../../src/langium/workspace/hydranium-workspace-lock.js';
import {
   ReentrantWriteLockError,
   isInsideWriteLock,
   runInWriteLockScope,
   setWriteLockScope
} from '../../../src/langium/workspace/write-lock-scope.js';
import { nodeWriteLockScope } from '../../../src/node/write-lock-scope-node.js';

describe('write-lock scope', () => {
   afterEach(() => setWriteLockScope(undefined));

   describe('the neutral seam', () => {
      it('reports "not inside" and runs the action when no tracker is installed', () => {
         // Fail-open is the contract: a host without a tracker (a browser
         // bundle) must keep its current behaviour rather than gain rejections.
         setWriteLockScope(undefined);
         let ran = false;
         const result = runInWriteLockScope(() => {
            ran = true;
            return isInsideWriteLock();
         });
         expect(ran).toBe(true);
         expect(result).toBe(false);
         expect(isInsideWriteLock()).toBe(false);
      });
   });

   describe('the Node tracker', () => {
      it('reports "inside" only within the scope, and returns the value', () => {
         setWriteLockScope(nodeWriteLockScope);
         expect(isInsideWriteLock()).toBe(false);
         expect(runInWriteLockScope(() => isInsideWriteLock())).toBe(true);
         expect(isInsideWriteLock()).toBe(false);
      });

      it('follows the async stack across awaits rather than leaking to interleaved work', async () => {
         // The reason this needs AsyncLocalStorage and not a boolean flag: the
         // lock's action is async, so a flag set around it would report
         // "inside" for every unrelated task that runs while it awaits.
         setWriteLockScope(nodeWriteLockScope);
         const observed: Array<[string, boolean]> = [];
         const inside = runInWriteLockScope(async () => {
            observed.push(['scope:before-await', isInsideWriteLock()]);
            await Promise.resolve();
            observed.push(['scope:after-await', isInsideWriteLock()]);
         });
         const outside = (async () => {
            await Promise.resolve();
            observed.push(['interleaved', isInsideWriteLock()]);
         })();

         await Promise.all([inside, outside]);
         // Asserted as a map, not a sequence: the contract is WHICH tasks see
         // the scope, and pinning the microtask interleaving order instead
         // would make this fail on a scheduling detail it does not care about.
         expect(Object.fromEntries(observed)).toEqual({
            'scope:before-await': true,
            'scope:after-await': true,
            interleaved: false
         });
         expect(observed).toHaveLength(3);
      });

      it('nests, so an inner scope does not clear the outer one', async () => {
         setWriteLockScope(nodeWriteLockScope);
         await runInWriteLockScope(async () => {
            await runInWriteLockScope(async () => Promise.resolve());
            expect(isInsideWriteLock()).toBe(true);
         });
      });
   });

   describe('HydraniumWorkspaceLock', () => {
      it('marks its write action as inside, and its read action as outside', async () => {
         // `read` is deliberately unmarked: a read action does not cancel a
         // running holder, so reaching the facade from one is not the hazard.
         setWriteLockScope(nodeWriteLockScope);
         const lock = new HydraniumWorkspaceLock();
         let duringWrite: boolean | undefined;
         let duringRead: boolean | undefined;
         await lock.write(async () => {
            duringWrite = isInsideWriteLock();
         });
         await lock.read(async () => {
            duringRead = isInsideWriteLock();
         });
         expect(duringWrite).toBe(true);
         expect(duringRead).toBe(false);
      });

      it('keeps the scope across an await inside the write action', async () => {
         setWriteLockScope(nodeWriteLockScope);
         const lock = new HydraniumWorkspaceLock();
         let afterAwait: boolean | undefined;
         await lock.write(async () => {
            await Promise.resolve();
            afterAwait = isInsideWriteLock();
         });
         expect(afterAwait).toBe(true);
      });

      it('does not report "inside" after the write action has settled', async () => {
         setWriteLockScope(nodeWriteLockScope);
         const lock = new HydraniumWorkspaceLock();
         await lock.write(async () => Promise.resolve());
         expect(isInsideWriteLock()).toBe(false);
      });
   });

   describe('ReentrantWriteLockError', () => {
      it('names itself and points at both remedies', () => {
         const error = new ReentrantWriteLockError('file:///workspace/a.a');
         expect(error.name).toBe('ReentrantWriteLockError');
         expect(error.uri).toBe('file:///workspace/a.a');
         expect(error.message).toContain('file:///workspace/a.a');
         expect(error.message).toContain('FileSystemProvider.writeFile');
         expect(error.message).toContain('serializeBuilds');
      });
   });
});
