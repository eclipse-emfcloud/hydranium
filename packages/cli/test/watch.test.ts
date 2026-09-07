/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { TransferDocument } from '@hydranium/protocol';
import type { DataClientProtocol, WatchModelDocumentArgs, TransferDocumentUpdatedEvent } from '@hydranium/protocol/data';

interface FakeRoot {
   readonly $type: 'FakeRoot';
   readonly v: number;
}
import { runWatch, type WatchTestHandle } from '../src/commands/watch.js';

interface WatchHarness {
   handle: WatchTestHandle;
   readonly subscribes: readonly WatchModelDocumentArgs[];
   readonly unsubscribes: readonly WatchModelDocumentArgs[];
   readonly shutdownCalls: { count: number };
   /**
    * Push an event into runWatch's local client. Only callable AFTER
    * runWatch has invoked `bindClient` — the harness throws if called
    * earlier so tests fail loudly on race conditions.
    */
   fire(event: TransferDocumentUpdatedEvent<FakeRoot>): void;
   /**
    * Reproduce the child's death: reject `whenTerminated` with the message the
    * real spawn helper produces, and — because a dead child answers nothing —
    * leave every later `unwatchModelDocument` pending.
    */
   killChild(signal: string): void;
}

/**
 * `withChild` gives the handle a `whenTerminated`, which is what makes the
 * premature-death race reachable at all; without it the fixture stands in for a
 * handle that has no child to lose.
 */
function makeHarness(options: { readonly withChild?: boolean } = {}): WatchHarness {
   const subscribes: WatchModelDocumentArgs[] = [];
   const unsubscribes: WatchModelDocumentArgs[] = [];
   const shutdownCalls = { count: 0 };
   let boundClient: DataClientProtocol<FakeRoot> | undefined;
   let childDead = false;
   let rejectTerminated: ((error: Error) => void) | undefined;
   const whenTerminated = options.withChild
      ? new Promise<never>((_resolve, reject) => {
           rejectTerminated = reject;
        })
      : undefined;
   // Never observed unless a test kills the child; the handle keeps it handled
   // exactly as the production one does.
   void whenTerminated?.catch(() => undefined);

   const handle: WatchTestHandle = {
      server: {
         async watchModelDocument(args) {
            subscribes.push(args);
         },
         async unwatchModelDocument(args) {
            if (childDead) {
               return new Promise<void>(() => undefined);
            }
            unsubscribes.push(args);
         }
      },
      bindClient(client) {
         boundClient = client;
      },
      async shutdown() {
         shutdownCalls.count += 1;
      },
      whenTerminated
   };

   return {
      handle,
      subscribes,
      unsubscribes,
      shutdownCalls,
      fire(event) {
         if (!boundClient) {
            throw new Error('WatchHarness.fire called before runWatch bound its local client');
         }
         boundClient.onDocumentUpdated(event);
      },
      killChild(signal) {
         if (!rejectTerminated) {
            throw new Error('WatchHarness.killChild needs a harness built with withChild');
         }
         childDead = true;
         rejectTerminated(
            new Error(`data-server process exited before the request completed (command='node', code=null, signal=${signal}).`)
         );
      }
   };
}

describe('runWatch', () => {
   it('writes each event as one JSON line and unsubscribes + shuts down on abort', async () => {
      const harness = makeHarness();
      const written: string[] = [];
      const controller = new AbortController();
      const run = runWatch({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         clientId: 'watcher',
         write: line => written.push(line),
         signal: controller.signal,
         __handleForTest: harness.handle
      });

      // Let subscribe land.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(harness.subscribes).toHaveLength(1);
      expect(harness.subscribes[0]).toEqual({ uri: 'file:///workspace/A.fake', clientId: 'watcher' });

      harness.fire({
         document: TransferDocument.create<FakeRoot>('file:///workspace/A.fake', 1, { $type: 'FakeRoot', v: 1 }),
         sourceClientId: 'editor-1',
         reason: 'changed'
      });
      harness.fire({
         document: TransferDocument.create<FakeRoot>('file:///workspace/A.fake', 2, { $type: 'FakeRoot', v: 2 }),
         sourceClientId: 'editor-1',
         reason: 'changed'
      });

      controller.abort();
      await run;

      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]).document.root).toEqual({ $type: 'FakeRoot', v: 1 });
      expect(JSON.parse(written[1]).document.root).toEqual({ $type: 'FakeRoot', v: 2 });
      expect(harness.unsubscribes).toHaveLength(1);
      expect(harness.unsubscribes[0]).toEqual({ uri: 'file:///workspace/A.fake', clientId: 'watcher' });
      expect(harness.shutdownCalls.count).toBe(1);
   });

   it('filters events by URI — notifications for other URIs are dropped', async () => {
      const harness = makeHarness();
      const written: string[] = [];
      const controller = new AbortController();
      const run = runWatch({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         clientId: 'watcher',
         write: line => written.push(line),
         signal: controller.signal,
         __handleForTest: harness.handle
      });

      await new Promise(resolve => setTimeout(resolve, 0));

      // Notification for a different URI — must be ignored.
      harness.fire({
         document: TransferDocument.create<FakeRoot>('file:///workspace/B.fake', 1, { $type: 'FakeRoot', v: 1 }),
         sourceClientId: 'editor-1',
         reason: 'changed'
      });
      harness.fire({
         document: TransferDocument.create<FakeRoot>('file:///workspace/A.fake', 2, { $type: 'FakeRoot', v: 2 }),
         sourceClientId: 'editor-1',
         reason: 'changed'
      });

      controller.abort();
      await run;

      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]).document.uri).toBe('file:///workspace/A.fake');
   });

   /**
    * Ctrl-C reaches the whole process group, so the child dies of the same
    * keystroke that ends the watch and its unwatch round trip can never be
    * answered. Both orderings are covered because the kernel picks between them:
    * whichever of the two arrives first, a clean stop must not be reported as
    * `data-server process exited before the request completed`.
    */
   it('treats a child that dies with the abort as the documented shutdown', async () => {
      const harness = makeHarness({ withChild: true });
      const controller = new AbortController();
      const run = runWatch({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         write: () => undefined,
         signal: controller.signal,
         __handleForTest: harness.handle
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      controller.abort();
      harness.killChild('SIGINT');

      await expect(run).resolves.toBeUndefined();
      expect(harness.shutdownCalls.count).toBe(1);
   });

   it('treats it as the documented shutdown when the child death lands first', async () => {
      const harness = makeHarness({ withChild: true });
      const controller = new AbortController();
      const run = runWatch({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         write: () => undefined,
         signal: controller.signal,
         __handleForTest: harness.handle
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      harness.killChild('SIGINT');
      controller.abort();

      await expect(run).resolves.toBeUndefined();
      expect(harness.shutdownCalls.count).toBe(1);
   });

   it('still reports a child that dies while the watch is running', async () => {
      const harness = makeHarness({ withChild: true });
      const controller = new AbortController();
      const run = runWatch({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         write: () => undefined,
         signal: controller.signal,
         __handleForTest: harness.handle
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      harness.killChild('SIGSEGV');

      await expect(run).rejects.toThrow('exited before the request completed');
      expect(harness.shutdownCalls.count).toBe(1);
   });

   it('exits immediately when the signal is already aborted', async () => {
      const harness = makeHarness();
      const controller = new AbortController();
      controller.abort();
      await runWatch({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         write: () => undefined,
         signal: controller.signal,
         __handleForTest: harness.handle
      });
      // Even an immediately-aborted run subscribes once + unsubscribes + shuts down.
      expect(harness.subscribes).toHaveLength(1);
      expect(harness.unsubscribes).toHaveLength(1);
      expect(harness.shutdownCalls.count).toBe(1);
   });
});
