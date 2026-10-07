/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
   Action,
   ActionDispatchScope,
   ActionHandlerRegistry,
   ClientActionForwarder,
   Logger as GlspLogger
} from '@eclipse-glsp/server/node.js';
import { Logger, type LogThreshold, type Tracer } from '@hydranium/protocol';
import { HydraniumGlspServerActionDispatcher } from '../src/dispatcher/server-action-dispatcher.js';
import { makeNoopGlspLogger } from '../src/testing/make-noop-glsp-logger.js';

class TestableDispatcher extends HydraniumGlspServerActionDispatcher {
   public timedLabels: string[] = [];
   public timedLevels: (LogThreshold | undefined)[] = [];
   public dispatched: Action[] = [];
   public handledKinds: string[] = [];
   public summarizeCalls = 0;
   public override loggedKinds: ReadonlySet<string> | undefined = undefined;
   public summaries = new Map<string, string>();

   constructor() {
      super();
      // Stub the parent-class DI fields directly — bypasses Inversify so the
      // override's logging logic can be exercised in isolation. `logger` is
      // `readonly` on the framework class (matches GLSP's `@inject` shape);
      // the writable cast lands the stubs on the instance.
      const writable = this as unknown as {
         logger: GlspLogger;
         tracer: Tracer;
         clientActionForwarder: ClientActionForwarder & { handle: (a: Action) => boolean };
         actionHandlerRegistry: ActionHandlerRegistry;
         dispatchScope: ActionDispatchScope;
      };
      writable.logger = makeNoopGlspLogger();
      // Dispatch timing goes through the injected, caller-tagged `Tracer`.
      writable.tracer = {
         time: <T>(label: string, callback: () => T, logLevel?: LogThreshold) => {
            this.timedLabels.push(label);
            this.timedLevels.push(logLevel);
            return Promise.resolve(callback() as Awaited<T>);
         }
      } as unknown as Tracer;
      writable.clientActionForwarder = {
         shouldForwardToClient: (action: Action) => action.kind.endsWith('-out'),
         handle: () => true
      } as unknown as ClientActionForwarder & { handle: (a: Action) => boolean };
      writable.actionHandlerRegistry = {
         get: (kind: string) => {
            this.handledKinds.push(kind);
            return [];
         }
      } as unknown as ActionHandlerRegistry;
      // GLSP injects this so the dispatcher can route a reentrant dispatch
      // inline while queueing an external one. Report every dispatch as
      // reentrant: these tests exercise the logging override on `doDispatch`,
      // and the queued path would need the `processActionQueue` pump that only
      // a fully wired server runs, so an external dispatch would just hang.
      writable.dispatchScope = {
         enter: <R>(callback: () => R) => callback(),
         isReentrant: () => true
      };
   }

   public setLoggedKinds(kinds: ReadonlySet<string> | undefined): void {
      this.loggedKinds = kinds;
   }

   public setSummary(kind: string, summary: string): void {
      this.summaries.set(kind, summary);
   }

   protected override summarize(action: Action): string {
      this.summarizeCalls++;
      return this.summaries.get(action.kind) ?? '';
   }

   public override dispatch(action: Action): Promise<void> {
      this.dispatched.push(action);
      return super.dispatch(action);
   }
}

describe('HydraniumGlspServerActionDispatcher', () => {
   let previousLevel: LogThreshold;
   beforeEach(() => {
      previousLevel = Logger.getLevel();
      Logger.setLevel('debug');
   });
   afterEach(() => {
      Logger.setLevel(previousLevel);
   });

   it('logs every dispatched action by default with `→ server` direction', async () => {
      const dispatcher = new TestableDispatcher();
      await dispatcher.dispatch({ kind: 'foo' });
      expect(dispatcher.timedLabels).toEqual([`Dispatch action 'foo' → server`]);
   });

   it('times at debug', async () => {
      const dispatcher = new TestableDispatcher();
      await dispatcher.dispatch({ kind: 'foo' });
      expect(dispatcher.timedLevels).toEqual(['debug']);
   });

   it('neither summarizes nor times a dispatch below debug, and still handles it', async () => {
      Logger.setLevel('info');
      const dispatcher = new TestableDispatcher();
      await dispatcher.dispatch({ kind: 'foo' });
      expect(dispatcher.summarizeCalls).toBe(0);
      expect(dispatcher.timedLabels).toEqual([]);
      expect(dispatcher.handledKinds).toEqual(['foo']);
   });

   it('shows `→ client` direction when the forwarder routes to client', async () => {
      const dispatcher = new TestableDispatcher();
      await dispatcher.dispatch({ kind: 'bar-out' });
      expect(dispatcher.timedLabels).toEqual([`Dispatch action 'bar-out' → client`]);
   });

   it('skips the timing line when loggedKinds excludes the action kind', async () => {
      const dispatcher = new TestableDispatcher();
      dispatcher.setLoggedKinds(new Set(['only-this']));
      await dispatcher.dispatch({ kind: 'noisy' });
      expect(dispatcher.timedLabels).toEqual([]);
      // Dispatch still happens (the base class still receives the action).
      expect(dispatcher.dispatched).toHaveLength(1);
   });

   it('emits the timing line when loggedKinds includes the action kind', async () => {
      const dispatcher = new TestableDispatcher();
      dispatcher.setLoggedKinds(new Set(['only-this']));
      await dispatcher.dispatch({ kind: 'only-this' });
      expect(dispatcher.timedLabels).toEqual([`Dispatch action 'only-this' → server`]);
   });

   it('appends `[summary]` bracket when summarize() returns a non-empty string', async () => {
      const dispatcher = new TestableDispatcher();
      dispatcher.setSummary('big-payload', 'rootType=Foo children=4');
      await dispatcher.dispatch({ kind: 'big-payload' });
      expect(dispatcher.timedLabels).toEqual([`Dispatch action 'big-payload' → server [rootType=Foo children=4]`]);
   });

   it('does NOT append the summary bracket when summarize() returns an empty string', async () => {
      const dispatcher = new TestableDispatcher();
      await dispatcher.dispatch({ kind: 'no-summary' });
      expect(dispatcher.timedLabels).toEqual([`Dispatch action 'no-summary' → server`]);
   });
});
