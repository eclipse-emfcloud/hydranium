/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Disposable, Logger } from '@hydranium/protocol';
import type { PreferenceService } from '@theia/core/lib/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLevelPreferenceContribution } from '../../src/browser/log-level-preference';

const PREFERENCE = 'x.level';

/** A `PreferenceService` stand-in that records subscriptions and their disposal,
 *  so a leaked listener is directly assertable rather than inferred. */
interface StubPreferences {
   service: PreferenceService;
   setValue(value: string | undefined): void;
   fireChange(preferenceName?: string): void;
   /** Subscriptions that have NOT been disposed. */
   liveListeners(): number;
   /** Total subscriptions ever made, disposed or not. */
   readonly subscribeCount: number;
}

function makeStubPreferences(initial: string | undefined): StubPreferences {
   let value = initial;
   const handlers = new Map<number, (event: { preferenceName: string }) => void>();
   let nextId = 0;
   let subscribeCount = 0;
   const service = {
      ready: Promise.resolve(),
      get: () => value,
      onPreferenceChanged: (handler: (event: { preferenceName: string }) => void) => {
         const id = nextId++;
         subscribeCount++;
         handlers.set(id, handler);
         return Disposable.create(() => handlers.delete(id));
      }
   } as unknown as PreferenceService;
   return {
      service,
      setValue: next => (value = next),
      fireChange: (preferenceName = PREFERENCE) => handlers.forEach(handler => handler({ preferenceName })),
      liveListeners: () => handlers.size,
      get subscribeCount() {
         return subscribeCount;
      }
   };
}

/** Wires the contribution's injected fields without resolving a container. */
function makeContribution(preferences: PreferenceService, logger: { error: unknown } = { error: vi.fn() }): LogLevelPreferenceContribution {
   const contribution = new LogLevelPreferenceContribution();
   const fields = contribution as unknown as { preferenceName: string; preferences: PreferenceService; logger: unknown };
   fields.preferenceName = PREFERENCE;
   fields.preferences = preferences;
   fields.logger = logger;
   return contribution;
}

/**
 * Drive the startup body and await it. `onStart` deliberately returns `void` so
 * Theia does not await it — awaiting `preferences.ready` inside the lifecycle hook
 * deadlocks the frontend on its preload — so a test that needs the settled state
 * has to reach the body directly.
 */
function start(contribution: LogLevelPreferenceContribution): Promise<void> {
   return (contribution as unknown as { applyWhenReady(): Promise<void> }).applyWhenReady();
}

describe('LogLevelPreferenceContribution', () => {
   beforeEach(() => {
      Logger.setLevel('info');
   });

   afterEach(() => {
      Logger.setLevel('info');
   });

   it('applies the threshold on start', async () => {
      const prefs = makeStubPreferences('debug');
      await start(makeContribution(prefs.service));
      expect(Logger.getLevel()).toBe('debug');
   });

   it('does not block the frontend lifecycle on preference readiness', () => {
      // Regression guard: an awaited `onStart` deadlocks Theia's startup, because
      // `preferences.ready` only resolves as part of the same startup sequence.
      const prefs = makeStubPreferences('debug');
      expect(makeContribution(prefs.service).onStart()).toBeUndefined();
   });

   it('re-applies on a change to the watched preference', async () => {
      const prefs = makeStubPreferences('debug');
      await start(makeContribution(prefs.service));
      prefs.setValue('warn');
      prefs.fireChange();
      expect(Logger.getLevel()).toBe('warn');
   });

   it('ignores a change to an unrelated preference', async () => {
      const prefs = makeStubPreferences('debug');
      await start(makeContribution(prefs.service));
      prefs.setValue('warn');
      prefs.fireChange('some.other.preference');
      expect(Logger.getLevel()).toBe('debug');
   });

   it('leaves the current threshold alone for an unparseable value', async () => {
      // Another source (an env baseline, a test) may have set it deliberately;
      // an unreadable preference is not a reason to reset.
      Logger.setLevel('warn');
      await start(makeContribution(makeStubPreferences('not-a-level').service));
      expect(Logger.getLevel()).toBe('warn');
   });

   it('leaves the current threshold alone when the preference is unset', async () => {
      Logger.setLevel('warn');
      await start(makeContribution(makeStubPreferences(undefined).service));
      expect(Logger.getLevel()).toBe('warn');
   });

   describe('listener lifetime', () => {
      it('subscribes exactly once', async () => {
         const prefs = makeStubPreferences('debug');
         await start(makeContribution(prefs.service));
         expect(prefs.subscribeCount).toBe(1);
         expect(prefs.liveListeners()).toBe(1);
      });

      it('does not subscribe twice if start runs again', async () => {
         // An owner constructed once per diagram container would add a listener per
         // diagram and dispose none, which is the failure this guard prevents.
         const prefs = makeStubPreferences('debug');
         const contribution = makeContribution(prefs.service);
         await start(contribution);
         await start(contribution);
         expect(prefs.subscribeCount).toBe(1);
         expect(prefs.liveListeners()).toBe(1);
      });

      it('disposes the subscription on stop', async () => {
         const prefs = makeStubPreferences('debug');
         const contribution = makeContribution(prefs.service);
         await start(contribution);
         contribution.onStop();
         expect(prefs.liveListeners()).toBe(0);
      });

      it('tolerates stop without start', () => {
         const prefs = makeStubPreferences('debug');
         expect(() => makeContribution(prefs.service).onStop()).not.toThrow();
      });

      it('does not strand a subscription that lands after stop', async () => {
         // `DisposableCollection` disposes a push-after-dispose immediately, so even
         // an out-of-order lifecycle cannot leave a listener behind.
         const prefs = makeStubPreferences('debug');
         const contribution = makeContribution(prefs.service);
         contribution.onStop();
         await start(contribution);
         expect(prefs.liveListeners()).toBe(0);
      });
   });

   it('reports a failure to read the preference instead of swallowing it', async () => {
      // A bare `.catch(() => undefined)` here would make a misconfigured threshold
      // indistinguishable from a working one.
      const logger = { error: vi.fn() };
      const boom = new Error('preferences unavailable');
      const prefs = {
         ready: Promise.resolve(),
         get: () => {
            throw boom;
         },
         onPreferenceChanged: () => Disposable.EMPTY
      } as unknown as PreferenceService;

      await expect(start(makeContribution(prefs, logger))).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(`Failed to apply the log threshold from '${PREFERENCE}'`, boom);
   });
});
