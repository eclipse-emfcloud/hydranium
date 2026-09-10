/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The real `@hydranium/client-theia/browser` module loads `@theia/output` → DOM
// globals unavailable in the node test env. A bare class stand-in is enough since
// the loader is constructed directly, never via a container.
vi.mock('@hydranium/client-theia/lib/browser', () => ({
   ChannelLogger: class ChannelLogger {}
}));

import { type Action, StatusAction } from '@eclipse-glsp/client';
import { nls } from '@theia/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HydraniumDiagramLoader } from '../../src/browser/diagram-loader';

/** Exposes the protected reporting hook and lets the test wire the protected
 *  injected collaborators without resolving a GLSP container. */
class TestableLoader extends HydraniumDiagramLoader {
   setChannel(channel: unknown): void {
      (this as unknown as { channel: unknown }).channel = channel;
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
   let channel: { error: ReturnType<typeof vi.fn> };
   let dispatch: ReturnType<typeof vi.fn>;
   let loader: TestableLoader;

   beforeEach(() => {
      channel = { error: vi.fn() };
      dispatch = vi.fn().mockResolvedValue(undefined);
      loader = new TestableLoader();
      loader.setChannel(channel);
      loader.setActionDispatcher({ dispatch });
   });

   it('swallows a load failure instead of rejecting (no uncaught rejection)', async () => {
      loader.makeSuperLoadThrow(new Error('connection refused'));
      await expect(loader.load()).resolves.toBeUndefined();
   });

   it('routes a load failure to the Output channel', async () => {
      const err = new Error('connection refused');
      loader.makeSuperLoadThrow(err);
      await loader.load();
      expect(channel.error).toHaveBeenCalledWith('Diagram failed to load: connection refused', err);
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
      expect(channel.error).toHaveBeenCalledWith('Diagram failed to load: boom', 'boom');
      const status = dispatch.mock.calls[0][0] as StatusAction;
      expect(status.message).toBe('Diagram failed to load: boom');
   });

   it('does not re-escape when surfacing the status itself fails', async () => {
      dispatch.mockRejectedValueOnce(new Error('dispatcher down'));
      await expect(loader.exposeReportLoadFailure(new Error('connection refused'))).resolves.toBe(false);
      // Primary failure + secondary (status-surface) failure are both logged.
      expect(channel.error).toHaveBeenCalledWith('Diagram failed to load: connection refused', expect.any(Error));
      expect(channel.error).toHaveBeenCalledWith('Failed to surface the diagram-load failure on the status overlay', expect.any(Error));
   });

   it('reports whether the failure reached the status overlay', async () => {
      await expect(loader.exposeReportLoadFailure(new Error('connection refused'))).resolves.toBe(true);
   });

   /**
    * The KEY, not the sentence. Every assertion above reads the English default,
    * which `nls.localize` returns unchanged when no catalogue is loaded — so all
    * of them pass just as well with the key renamed, or with the call removed
    * entirely. The code is the contract and the English is the fallback, so the
    * contract needs an assertion of its own.
    *
    * The parameter is asserted here too, because `{0}` is what makes this one
    * entry rather than one per error text: a catalogue cannot hold a translation
    * for a sentence whose detail is baked into the key's default.
    */
   it('renders the failure through its catalogue key, with the detail as a parameter', async () => {
      const localize = vi.spyOn(nls, 'localize');
      loader.loadFailureLabel(new Error('connection refused'));
      expect(localize).toHaveBeenCalledWith(
         'hydranium/glsp-client-theia/diagram-load-failed',
         'Diagram failed to load: {0}',
         'connection refused'
      );
      localize.mockRestore();
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
         // `surfaced: true` tells a canvas-covering consumer that GLSP's status
         // overlay has the message, so it should uncover rather than double-report.
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
