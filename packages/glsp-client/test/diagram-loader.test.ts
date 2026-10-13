/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, StatusAction } from '@eclipse-glsp/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAGRAM_LOAD_FAILED } from '../src/diagram-load-failed';
import { HydraniumDiagramLoader } from '../src/diagram-loader';

/** Exposes the protected reporting hook and lets the test wire the protected
 *  injected collaborators without resolving a GLSP container. */
class TestableLoader extends HydraniumDiagramLoader {
   setLogger(logger: unknown): void {
      (this as unknown as { hydraniumLogger: unknown }).hydraniumLogger = logger;
   }
   setActionDispatcher(dispatcher: unknown): void {
      (this as unknown as { actionDispatcher: unknown }).actionDispatcher = dispatcher;
   }
   /** Force `super.load()` to reject at its first step (the `diagramStartups`
    *  sort, which reads `lazyInjector.getAll`) — emulating any init failure. */
   makeSuperLoadThrow(err: unknown): void {
      (this as unknown as { lazyInjector: unknown }).lazyInjector = {
         getAll: () => {
            throw err;
         }
      };
   }

   /** Wire the collaborators `super.load()` walks so it runs to completion: no
    *  startup hooks, a GLSP client that is already initialized, and a model
    *  constraint that is immediately satisfied. */
   makeSuperLoadSucceed(): void {
      const self = this as unknown as Record<string, unknown>;
      self.lazyInjector = { getAll: () => [] };
      self.options = {
         diagramType: 'test-diagram',
         sourceUri: 'file:///test.model',
         glspClientProvider: async () => ({ start: async () => undefined, initializeResult: {} })
      };
      self.modelSource = { configure: () => undefined };
      self.modelInitializationConstraint = { onInitialized: async () => undefined };
   }
   exposeReportLoadFailure(err: unknown): Promise<boolean> {
      return this.reportLoadFailure(err);
   }
}

describe('HydraniumDiagramLoader', () => {
   let logger: { error: ReturnType<typeof vi.fn> };
   let dispatch: ReturnType<typeof vi.fn>;
   let loader: TestableLoader;

   beforeEach(() => {
      logger = { error: vi.fn() };
      dispatch = vi.fn().mockResolvedValue(undefined);
      loader = new TestableLoader();
      loader.setLogger(logger);
      loader.setActionDispatcher({ dispatch });
   });

   it('swallows a load failure instead of rejecting (no uncaught rejection)', async () => {
      loader.makeSuperLoadThrow(new Error('connection refused'));
      await expect(loader.load()).resolves.toBeUndefined();
   });

   it('routes a load failure to the logger', async () => {
      const err = new Error('connection refused');
      loader.makeSuperLoadThrow(err);
      await loader.load();
      expect(logger.error).toHaveBeenCalledWith('Diagram failed to load: connection refused', err);
   });

   it('surfaces a persistent ERROR StatusAction on the status overlay', async () => {
      loader.makeSuperLoadThrow(new Error('connection refused'));
      await loader.load();
      expect(dispatch).toHaveBeenCalledTimes(1);
      const action = dispatch.mock.calls[0][0] as Action;
      expect(StatusAction.is(action)).toBe(true);
      const status = action as StatusAction;
      expect(status.severity).toBe('ERROR');
      expect(status.message).toBe('Diagram failed to load: connection refused');
      // No `timeout` set → the overlay does not auto-clear (stays visible).
      expect(status.timeout).toBeUndefined();
   });

   it('stringifies non-Error rejection values', async () => {
      await loader.exposeReportLoadFailure('boom');
      expect(logger.error).toHaveBeenCalledWith('Diagram failed to load: boom', 'boom');
      const status = dispatch.mock.calls[0][0] as StatusAction;
      expect(status.message).toBe('Diagram failed to load: boom');
   });

   it('does not re-escape when surfacing the status itself fails', async () => {
      dispatch.mockRejectedValueOnce(new Error('dispatcher down'));
      await expect(loader.exposeReportLoadFailure(new Error('connection refused'))).resolves.toBe(false);
      // Primary failure + secondary (status-surface) failure are both logged.
      expect(logger.error).toHaveBeenCalledWith('Diagram failed to load: connection refused', expect.any(Error));
      expect(logger.error).toHaveBeenCalledWith('Failed to surface the diagram-load failure on the status overlay', expect.any(Error));
   });

   it('reports whether the failure reached the status overlay', async () => {
      await expect(loader.exposeReportLoadFailure(new Error('connection refused'))).resolves.toBe(true);
   });

   /**
    * The CODE, not the sentence. Every assertion above reads the English, which
    * passes just as well with the declaration renamed. The code is what a host
    * with a locale renders through, so it needs an assertion of its own, and
    * the placeholder is what makes this one entry rather than one per error.
    */
   it('reports the failure as the declared message with the detail as its parameter', () => {
      expect(DIAGRAM_LOAD_FAILED.code).toBe('hydranium/glsp-client/diagram-load-failed');
      expect(DIAGRAM_LOAD_FAILED.text).toBe('Diagram failed to load: {reason}');
      expect(loader.loadFailureLabel(new Error('connection refused'))).toBe(DIAGRAM_LOAD_FAILED.format({ reason: 'connection refused' }));
   });

   describe('load outcome', () => {
      it('reports no outcome while the load is in flight', () => {
         expect(loader.loadOutcome).toBeUndefined();
      });

      it('settles loaded on success', async () => {
         // `super.load()` needs no collaborators beyond the ones stubbed above once
         // the startup list is empty and the model source is a no-op.
         loader.makeSuperLoadSucceed();
         await loader.load();
         expect(loader.loadOutcome).toEqual({ status: 'loaded' });
         await expect(loader.onceLoadSettled()).resolves.toEqual({ status: 'loaded' });
      });

      it('settles failed carrying the error and that it was surfaced', async () => {
         const err = new Error('connection refused');
         loader.makeSuperLoadThrow(err);
         await loader.load();
         expect(loader.loadOutcome).toEqual({ status: 'failed', error: err, surfaced: true });
      });

      it('marks the failure unsurfaced when the status dispatch also fails', async () => {
         // The decisive case: when the action dispatcher is itself what failed to
         // initialize, no StatusAction ever lands. The load must still settle (a
         // consumer waiting on an observed action would hang), and it must say so —
         // whoever covers the canvas is now the only surface for the message.
         const err = new Error('connection refused');
         dispatch.mockRejectedValue(new Error('dispatcher down'));
         loader.makeSuperLoadThrow(err);
         await loader.load();
         await expect(loader.onceLoadSettled()).resolves.toEqual({ status: 'failed', error: err, surfaced: false });
      });

      it('carries a non-Error rejection value verbatim', async () => {
         loader.makeSuperLoadThrow('boom');
         await loader.load();
         expect(loader.loadOutcome).toEqual({ status: 'failed', error: 'boom', surfaced: true });
      });

      it('never rejects, so a consumer awaiting it cannot see an unhandled rejection', async () => {
         loader.makeSuperLoadThrow(new Error('connection refused'));
         const settled = loader.onceLoadSettled();
         await loader.load();
         await expect(settled).resolves.toMatchObject({ status: 'failed' });
      });

      it('keeps the first outcome when load is invoked again', async () => {
         loader.makeSuperLoadThrow(new Error('connection refused'));
         await loader.load();
         loader.makeSuperLoadSucceed();
         await loader.load();
         // A reload must not flip a settled overlay back to pending or re-resolve.
         expect(loader.loadOutcome).toMatchObject({ status: 'failed' });
         await expect(loader.onceLoadSettled()).resolves.toMatchObject({ status: 'failed' });
      });
   });
});
