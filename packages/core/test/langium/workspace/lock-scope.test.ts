/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Deferred, ReadPriority } from '@hydranium/langium';
import { SystemClock } from '@hydranium/protocol';
import { makeFakeClock, tick } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { HydraniumWorkspaceLock } from '../../../src/langium/workspace/hydranium-workspace-lock.js';
import { makeNoopTracer } from '../../../src/testing/index.js';
import { captureUnhandledRejections } from '../../../src/testing/node/unhandled-rejections.js';
import {
   ReentrantWriteLockError,
   currentReadHold,
   isInsideReadLock,
   isInsideWriteLock,
   isWriteLockScopeInstalled,
   releaseReadHolds,
   runInWriteLockScope,
   setReadLockScope,
   setWriteLockScope
} from '../../../src/langium/workspace/lock-scope.js';
import { nodeReadLockScope, nodeWriteLockScope } from '../../../src/node/lock-scope-node.js';

/** A limit beyond the test timeout, so a missing release fails rather than waiting it out. */
const NO_READ_HOLD_LIMIT = { readHoldLimitMs: 60_000 };

describe('workspace lock scopes', () => {
   afterEach(() => {
      setWriteLockScope(undefined);
      setReadLockScope(undefined);
   });

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

      it('reports whether a tracker is installed, which "not inside" alone cannot', () => {
         setWriteLockScope(undefined);
         expect(isWriteLockScopeInstalled()).toBe(false);
         setWriteLockScope(nodeWriteLockScope);
         expect(isWriteLockScopeInstalled()).toBe(true);
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
      it('marks its write action in the write scope, and its read action in the read scope', async () => {
         setWriteLockScope(nodeWriteLockScope);
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         let duringWrite: [boolean, boolean] | undefined;
         let duringRead: [boolean, boolean] | undefined;
         await lock.write(async () => {
            duringWrite = [isInsideWriteLock(), isInsideReadLock()];
         });
         await lock.read(async () => {
            duringRead = [isInsideWriteLock(), isInsideReadLock()];
         });
         expect({ duringWrite, duringRead }).toEqual({ duringWrite: [true, false], duringRead: [false, true] });
      });

      it('runs a write queued from inside a read while the read waits for it, outside the read scope', async () => {
         // The write starts in the context of whoever queued it, here the read.
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         let duringWrite: boolean | undefined;
         await lock.read(async () => {
            await lock.write(() => {
               duringWrite = isInsideReadLock();
            });
         }, ReadPriority.Immediate);
         expect(duringWrite).toBe(false);
      });

      it('keeps holding its own writes off when a read writes to another lock', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const other = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const otherWritten = new Deferred<void>();
         const gate = new Deferred<void>();
         let ran = false;
         const reading = lock.read(async () => {
            await other.write(() => undefined);
            otherWritten.resolve();
            await gate.promise;
         }, ReadPriority.Immediate);
         const queued = lock.write(() => {
            ran = true;
         });

         await otherWritten.promise;
         await tick();
         const ranWhileReading = ran;
         gate.resolve();
         await Promise.all([reading, queued]);

         expect({ ranWhileReading, ran }).toEqual({ ranWhileReading: false, ran: true });
      });

      it('keeps the write mark in a read started inside a write', async () => {
         setWriteLockScope(nodeWriteLockScope);
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         let duringRead: [boolean, boolean] | undefined;
         await lock.write(async () => {
            await lock.read(() => {
               duringRead = [isInsideWriteLock(), isInsideReadLock()];
            }, ReadPriority.Immediate);
         });
         expect(duringRead).toEqual([true, true]);
      });

      it('keeps the scope across an await inside the write action', async () => {
         setWriteLockScope(nodeWriteLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         let afterAwait: boolean | undefined;
         await lock.write(async () => {
            await Promise.resolve();
            afterAwait = isInsideWriteLock();
         });
         expect(afterAwait).toBe(true);
      });

      it('does not report "inside" after the write action has settled', async () => {
         setWriteLockScope(nodeWriteLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         await lock.write(async () => Promise.resolve());
         expect(isInsideWriteLock()).toBe(false);
      });

      it('reports a task the action spawned as outside once the action has settled', async () => {
         setWriteLockScope(nodeWriteLockScope);
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const gate = new Deferred<void>();
         const spawn = (): Promise<[boolean, boolean]> => gate.promise.then(() => [isInsideWriteLock(), isInsideReadLock()]);
         let fromWrite: Promise<[boolean, boolean]> | undefined;
         let fromRead: Promise<[boolean, boolean]> | undefined;
         await lock.write(async () => {
            fromWrite = spawn();
         });
         await lock.read(() => {
            fromRead = spawn();
         }, ReadPriority.Immediate);
         gate.resolve();
         expect(await Promise.all([fromWrite, fromRead])).toEqual([
            [false, false],
            [false, false]
         ]);
      });

      it('takes a hold that two overlapping waits released back once both settle', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const first = new Deferred<void>();
         const second = new Deferred<void>();
         const released = new Deferred<void>();
         const done = new Deferred<void>();
         const reading = lock.read(async () => {
            const waits = [releaseReadHolds(lock, () => first.promise), releaseReadHolds(lock, () => second.promise)];
            released.resolve();
            await Promise.all(waits);
            await done.promise;
         }, ReadPriority.Immediate);
         await released.promise;
         first.resolve();
         await tick();
         let firstWrote = false;
         const firstWriting = lock.write(() => {
            firstWrote = true;
         });
         await tick();
         const wroteWhileOneWaits = firstWrote;
         second.resolve();
         await tick();
         let secondWrote = false;
         const secondWriting = lock.write(() => {
            secondWrote = true;
         });
         await tick();
         const wroteOnceBothSettled = secondWrote;
         done.resolve();
         await Promise.all([reading, firstWriting, secondWriting]);

         expect({ wroteWhileOneWaits, wroteOnceBothSettled, secondWrote }).toEqual({
            wroteWhileOneWaits: true,
            wroteOnceBothSettled: false,
            secondWrote: true
         });
      });

      it.each([
         ['its own write', (lock: HydraniumWorkspaceLock, body: () => Promise<void>) => lock.write(body)],
         [
            'its own write, released again around it as the builder does',
            (lock: HydraniumWorkspaceLock, body: () => Promise<void>) =>
               releaseReadHolds(lock, retake =>
                  lock.write(async () => {
                     try {
                        await body();
                     } finally {
                        retake();
                     }
                  })
               )
         ],
         ['a read it queues', (lock: HydraniumWorkspaceLock, body: () => Promise<void>) => lock.read(body)]
      ])('holds off a write queued while %s runs until the read ends', async (_shape, wait) => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const started = new Deferred<void>();
         const finish = new Deferred<void>();
         const gate = new Deferred<void>();
         const events: string[] = [];
         const reading = lock.read(async () => {
            await wait(lock, async () => {
               started.resolve();
               await finish.promise;
            });
            events.push('read resumed');
            await gate.promise;
            events.push('read ended');
         }, ReadPriority.Immediate);
         await started.promise;
         const writing = lock.write(() => {
            events.push('write');
         });
         finish.resolve();
         await tick();
         gate.resolve();
         await Promise.all([reading, writing]);

         expect(events).toEqual(['read resumed', 'read ended', 'write']);
      });

      it('holds off a write a queued read queues and reads on beside, until the read ends', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const gate = new Deferred<void>();
         const events: string[] = [];
         let writing: Promise<void> | undefined;
         const reading = lock.read(async () => {
            writing = lock.write(() => {
               events.push('write');
            });
            await gate.promise;
            events.push('read ended');
         });
         await tick();
         gate.resolve();
         await reading;
         await writing;

         expect(events).toEqual(['read ended', 'write']);
      });

      it('ends a queued read that awaits its own write once the read-hold limit passes', async () => {
         setReadLockScope(nodeReadLockScope);
         const clock = makeFakeClock();
         const lock = new HydraniumWorkspaceLock({ Clock: clock, Tracer: makeNoopTracer() }, { readHoldLimitMs: 1_000 });
         const reading = lock.read(async () => {
            await lock.write(() => undefined);
            return 'written';
         });
         await tick();

         clock.advance(1_000);

         await expect(reading).resolves.toBe('written');
      });

      it('shows the outer read to a task that outlives the read nested in it', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const other = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const gate = new Deferred<void>();
         let spawned: Promise<unknown> | undefined;
         await lock.read(async () => {
            await other.read(() => {
               spawned = gate.promise.then(() => currentReadHold()?.lock);
            }, ReadPriority.Immediate);
            gate.resolve();
            await spawned;
         }, ReadPriority.Immediate);
         expect(await spawned).toBe(lock);
      });

      it('shows no read to work a queued read left running once it has ended', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const writeStarted = new Deferred<void>();
         const writeGate = new Deferred<void>();
         const gate = new Deferred<void>();
         const done = new Deferred<void>();
         // The write is queued inside this read, so Langium drains its queue in this read's context.
         const reading = lock.read(async () => {
            const writing = lock.write(() => {
               writeStarted.resolve();
               return writeGate.promise;
            });
            await done.promise;
            await writing;
         }, ReadPriority.Immediate);
         await writeStarted.promise;
         let spawned: Promise<boolean> | undefined;
         const queued = lock.read(() => {
            spawned = gate.promise.then(() => isInsideReadLock());
         });
         writeGate.resolve();
         await queued;
         gate.resolve();
         const inside = await spawned;
         done.resolve();
         await reading;
         expect(inside).toBe(false);
      });

      it('lets a write start that a read nested in a read of another lock queues', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const other = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         let ran = false;
         await lock.read(
            () =>
               other.read(() =>
                  lock.write(() => {
                     ran = true;
                  })
               ),
            ReadPriority.Immediate
         );
         expect(ran).toBe(true);
      });

      it('reports the rejection of a write, a read, a release and a scope run its caller drops', async () => {
         setWriteLockScope(nodeWriteLockScope);
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const failures = ['write', 'queued read', 'immediate read', 'release', 'scope run'].map(name => new Error(name));
         const reported = await captureUnhandledRejections(async unhandled => {
            void lock.write(() => Promise.reject(failures[0]));
            void lock.read(() => Promise.reject(failures[1]));
            void lock.read(() => Promise.reject(failures[2]), ReadPriority.Immediate);
            void releaseReadHolds(lock, () => Promise.reject(failures[3]));
            void nodeReadLockScope.run(() => Promise.reject(failures[4]));
            await expect.poll(() => unhandled).toEqual(expect.arrayContaining(failures));
            return unhandled;
         });
         expect(reported).toEqual(expect.arrayContaining(failures));
      });

      it('takes the hold back when the wait throws before it returns a promise', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const failure = new Error('sync');
         const gate = new Deferred<void>();
         let ran = false;
         let thrown: unknown;
         const reading = lock.read(async () => {
            try {
               await releaseReadHolds(lock, () => {
                  throw failure;
               });
            } catch (error: unknown) {
               thrown = error;
            }
            await gate.promise;
         }, ReadPriority.Immediate);
         await tick();
         const writing = lock.write(() => {
            ran = true;
         });
         await tick();
         const ranWhileReading = ran;
         gate.resolve();
         await Promise.all([reading, writing]);
         expect({ thrown, ranWhileReading }).toEqual({ thrown: failure, ranWhileReading: false });
      });

      it('takes a hold back once however often its retake runs', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const released = new Deferred<void>();
         const gate = new Deferred<void>();
         const wrote = new Deferred<void>();
         let ran = false;
         let ranWhileReleased = false;
         const reading = lock.read(async () => {
            const hold = currentReadHold();
            if (hold === undefined) {
               throw new Error('The read has no hold');
            }
            const retake = hold.release();
            retake();
            retake();
            // A plain wait, since a write releases the holds again itself.
            const waiting = releaseReadHolds(lock, () => gate.promise);
            released.resolve();
            // A hold the retakes took back would keep the write off, and this would never settle.
            await wrote.promise;
            ranWhileReleased = ran;
            gate.resolve();
            await waiting;
         }, ReadPriority.Immediate);
         await released.promise;
         const writing = lock.write(() => {
            ran = true;
            wrote.resolve();
         });
         await Promise.all([reading, writing]);
         expect(ranWhileReleased).toBe(true);
      });

      it('runs a write the read queues and does not await beside the rest of the read', async () => {
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const wrote = new Deferred<void>();
         const reading = lock.read(async () => {
            void lock.write(() => {
               wrote.resolve();
            });
            // Without the release the write waits for the read, and this never settles.
            await wrote.promise;
         }, ReadPriority.Immediate);
         await expect(reading).resolves.toBeUndefined();
      });

      it('frees the whole read while one branch of it waits, so a write runs beside a sibling branch', async () => {
         // The cost of a release being per read, not per branch: a caller that
         // reads beside its wait awaits the wait first.
         setReadLockScope(nodeReadLockScope);
         const lock = new HydraniumWorkspaceLock({ Clock: new SystemClock(), Tracer: makeNoopTracer() }, NO_READ_HOLD_LIMIT);
         const released = new Deferred<void>();
         const gate = new Deferred<void>();
         const wrote = new Deferred<void>();
         let ran = false;
         let siblingSawWrite = false;
         const reading = lock.read(async () => {
            await Promise.all([
               releaseReadHolds(lock, () => {
                  released.resolve();
                  return gate.promise;
               }),
               (async () => {
                  await released.promise;
                  // A release that freed only its own branch would keep the write off, and this would never settle.
                  await wrote.promise;
                  siblingSawWrite = ran;
                  gate.resolve();
               })()
            ]);
         }, ReadPriority.Immediate);
         await released.promise;
         const writing = lock.write(() => {
            ran = true;
            wrote.resolve();
         });
         await Promise.all([reading, writing]);
         expect(siblingSawWrite).toBe(true);
      });

      it('ends the mark of an action that throws, so a task it spawned is outside', async () => {
         const gate = new Deferred<void>();
         let spawned: Promise<boolean> | undefined;
         expect(() =>
            nodeReadLockScope.run(() => {
               spawned = gate.promise.then(() => nodeReadLockScope.isInside());
               throw new Error('sync');
            })
         ).toThrow('sync');
         gate.resolve();
         expect(await spawned).toBe(false);
      });
   });

   describe('ReentrantWriteLockError', () => {
      it('names itself and points at both remedies', () => {
         const error = new ReentrantWriteLockError('file:///workspace/a.a');
         expect(error.name).toBe('ReentrantWriteLockError');
         expect(error.uri).toBe('file:///workspace/a.a');
         expect(error.message).toContain('file:///workspace/a.a');
         expect(error.message).toContain('FileSystemProvider.writeFile');
         expect(error.message).toContain('allowReentrantBuilds');
      });
   });
});
