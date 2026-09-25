/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The REAL base class is what the override is tested against, so its module is
// loaded rather than mocked. It is compiled CommonJS, which Node loads, and it
// requires `@eclipse-glsp/client`, whose build requires stylesheets; Node would
// parse those as JavaScript. Hoisted so the hook is in place before the imports
// below run. Unlike the diagram widget's module, this one reaches no DOM global.
vi.hoisted(() => {
   const { createRequire } = globalThis.process.getBuiltinModule('node:module');
   createRequire(__filename).extensions['.css'] = module => {
      module.exports = {};
   };
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorContextService, type GLSPActionDispatcher, SetDirtyStateAction } from '@eclipse-glsp/client';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { ModelSavedAction, type RequestSaveModelAction } from '@hydranium/protocol';
import { HydraniumGlspSaveable } from '../../src/browser/glsp-saveable';

/**
 * A saveable over GLSP's real editor context, which drops a dirty-state change
 * that does not change the flag, and a dispatcher that answers requests by id
 * as GLSP's does. A response nobody waits for any more settles nothing.
 */
function makeSaveable(): {
   saveable: HydraniumGlspSaveable;
   /** The requests sent, oldest first. */
   requests: RequestSaveModelAction[];
   /** The server's record of an edit: a dirty-state change to dirty. */
   edit(): void;
   /** The server's dirty-state change after a save: clean. */
   clean(): void;
   /** The server's response to a save that worked. */
   respond(request: RequestSaveModelAction): void;
   /** The server's whole answer to a save that worked: clean, then the response. */
   answer(request: RequestSaveModelAction): void;
   /** The server's answer to a save that failed: a rejection, the model still dirty. */
   fail(request: RequestSaveModelAction): void;
} {
   const context = new EditorContextService();
   const pending = new Map<string, Deferred<ModelSavedAction>>();
   const requests: RequestSaveModelAction[] = [];
   const dispatcher = {
      // The server advertises the save request.
      hasHandler: () => true,
      request(action: RequestSaveModelAction): Promise<ModelSavedAction> {
         action.requestId = `client_${requests.length + 1}`;
         requests.push(action);
         const response = new Deferred<ModelSavedAction>();
         pending.set(action.requestId, response);
         return response.promise;
      }
   };
   const saveable = new HydraniumGlspSaveable(dispatcher as unknown as GLSPActionDispatcher, context);
   const settle = (request: RequestSaveModelAction): Deferred<ModelSavedAction> | undefined => {
      const response = pending.get(request.requestId);
      pending.delete(request.requestId);
      return response;
   };
   const clean = (): void => {
      context.handle(SetDirtyStateAction.create(false, { reason: 'save' }));
   };
   const respond = (request: RequestSaveModelAction): void =>
      settle(request)?.resolve(ModelSavedAction.create({ responseId: request.requestId }));
   return {
      saveable,
      requests,
      edit: () => {
         context.handle(SetDirtyStateAction.create(true, { reason: 'operation' }));
      },
      clean,
      respond,
      answer: request => {
         clean();
         respond(request);
      },
      fail: request => settle(request)?.reject(new Error('disk full'))
   };
}

/** Record how a save settles, without an unhandled rejection. */
function track(saving: Promise<void>): { outcome?: string } {
   const record: { outcome?: string } = {};
   saving.then(
      () => (record.outcome = 'saved'),
      (error: unknown) => (record.outcome = error instanceof Error ? error.message : String(error))
   );
   return record;
}

describe('HydraniumGlspSaveable', () => {
   afterEach(() => {
      vi.useRealTimers();
   });

   it('stays dirty until its own response, though the clean state arrives first', async () => {
      const { saveable, requests, edit, answer } = makeSaveable();
      edit();
      // What Theia reads each time the saveable reports a dirty change.
      const reported: boolean[] = [];
      saveable.onDirtyChanged(() => reported.push(saveable.dirty));

      const saving = saveable.save();
      expect(saveable.dirty).toBe(true);
      answer(requests[0]);
      await saving;

      expect(reported).toEqual([true, false]);
      expect(saveable.dirty).toBe(false);
   });

   it('resolves both saves of a double save with no edit between', async () => {
      // The server answers both, but the second clean state changes nothing,
      // so GLSP's editor context never reports it.
      const { saveable, requests, edit, answer } = makeSaveable();
      edit();
      const first = saveable.save();
      const second = saveable.save();

      expect(requests).toHaveLength(2);
      answer(requests[0]);
      answer(requests[1]);

      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      expect(saveable.dirty).toBe(false);
   });

   it('sends a request of its own for a save after an edit, so the edit is saved', async () => {
      const { saveable, requests, edit, answer } = makeSaveable();
      edit();
      const first = track(saveable.save());
      edit();
      const second = track(saveable.save());

      expect(requests).toHaveLength(2);
      answer(requests[0]);
      await vi.waitFor(() => expect(first.outcome).toBe('saved'));
      // The first answer does not settle the save that covers the edit.
      expect(second.outcome).toBeUndefined();
      expect(saveable.dirty).toBe(true);

      answer(requests[1]);
      await vi.waitFor(() => expect(second.outcome).toBe('saved'));
   });

   it('rejects a failed save and leaves later saves unaffected', async () => {
      const { saveable, requests, edit, fail, answer } = makeSaveable();
      edit();
      const failed = saveable.save();
      fail(requests[0]);
      await expect(failed).rejects.toThrow('disk full');
      expect(saveable.dirty).toBe(true);

      const retried = saveable.save();
      answer(requests[1]);

      await expect(retried).resolves.toBeUndefined();
      expect(saveable.dirty).toBe(false);
   });

   it('lets a response that arrives after its save timed out settle nothing else', async () => {
      vi.useFakeTimers();
      const { saveable, requests, edit, answer } = makeSaveable();
      edit();
      const late = track(saveable.save());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(late.outcome).toBe('Save operation timed out');

      const next = track(saveable.save());
      answer(requests[0]);
      await vi.advanceTimersByTimeAsync(0);
      expect(next.outcome).toBeUndefined();

      answer(requests[1]);
      await vi.advanceTimersByTimeAsync(0);
      expect(next.outcome).toBe('saved');
   });

   it('waits for a pending save when the server is already clean', async () => {
      // Theia's Save All at exit calls `save` again while the Ctrl+S save is
      // pending; resolving at once would let the window close over it.
      const { saveable, requests, edit, clean, respond } = makeSaveable();
      edit();
      const first = saveable.save();
      clean();

      const exitSave = track(saveable.save());
      await Promise.resolve();
      expect(requests).toHaveLength(1);
      expect(exitSave.outcome).toBeUndefined();

      respond(requests[0]);
      await first;
      await vi.waitFor(() => expect(exitSave.outcome).toBe('saved'));
   });

   it('resolves at once when nothing is dirty or pending', async () => {
      const { saveable, requests } = makeSaveable();

      await saveable.save();

      expect(requests).toHaveLength(0);
   });

   it('waits past GLSP’s 2 s for a slow response', async () => {
      vi.useFakeTimers();
      const { saveable, requests, edit, answer } = makeSaveable();
      edit();
      const saving = track(saveable.save());

      await vi.advanceTimersByTimeAsync(5_000);
      expect(saving.outcome).toBeUndefined();
      answer(requests[0]);
      await vi.advanceTimersByTimeAsync(0);

      expect(saving.outcome).toBe('saved');
   });

   it('still gives up on a server that never answers', async () => {
      vi.useFakeTimers();
      const { saveable, edit } = makeSaveable();
      edit();
      const saving = saveable.save();
      const rejected = expect(saving).rejects.toThrow('timed out');

      await vi.advanceTimersByTimeAsync(10_000);

      await rejected;
      // Not saved, so still dirty: the exit check keeps asking.
      expect(saveable.dirty).toBe(true);
   });
});
