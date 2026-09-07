/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type Action, ComputedBoundsAction, GModelRoot } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { HydraniumGlspComputedBoundsActionHandler } from '../src/computed-bounds/hydranium-glsp-computed-bounds-action-handler.js';

interface LogCapture {
   debug: string[];
   trace: string[];
   warn: string[];
}

function makeLog(): LogCapture {
   return { debug: [], trace: [], warn: [] };
}

interface FakeState {
   readonly root: GModelRoot;
   readonly logger: {
      debug(msg: string): void;
      trace(msg: string): void;
      warn(msg: string): void;
   };
}

interface FakeSubmissionHandler {
   hasPendingInitialRequest(): boolean;
}

function makeState(root: GModelRoot, log: LogCapture): FakeState {
   return {
      root,
      logger: {
         debug(msg: string): void {
            log.debug.push(msg);
         },
         trace(msg: string): void {
            log.trace.push(msg);
         },
         warn(msg: string): void {
            log.warn.push(msg);
         }
      }
   };
}

function makeRoot(revision: number): GModelRoot {
   const root = new GModelRoot();
   root.revision = revision;
   root.id = 'root';
   root.type = 'graph';
   return root;
}

function bindFakes(
   handler: HydraniumGlspComputedBoundsActionHandler,
   state: FakeState,
   submission: FakeSubmissionHandler
): HydraniumGlspComputedBoundsActionHandler {
   const slots = handler as unknown as { modelState: FakeState; submissionHandler: FakeSubmissionHandler };
   slots.modelState = state;
   slots.submissionHandler = submission;
   return handler;
}

function makeAction(revision: number): ComputedBoundsAction {
   return ComputedBoundsAction.create([], { revision, routes: [] });
}

describe('HydraniumGlspComputedBoundsActionHandler', () => {
   it('warns when revision mismatches AND initial handshake is pending', () => {
      const log = makeLog();
      const state = makeState(makeRoot(7), log);
      const handler = bindFakes(new HydraniumGlspComputedBoundsActionHandler(), state, { hasPendingInitialRequest: () => true });

      const result = handler.execute(makeAction(3)) as Action[];

      expect(result).toEqual([]);
      expect(log.warn).toHaveLength(1);
      expect(log.warn[0]).toContain('initial handshake');
      expect(log.warn[0]).toContain('action.revision=3');
      expect(log.warn[0]).toContain('model.revision=7');
      expect(log.debug).toHaveLength(1); // entry log
      expect(log.debug[0]).toContain('execute entered');
   });

   it('debug-logs (does NOT warn) when revision mismatches and no initial handshake is pending', () => {
      const log = makeLog();
      const state = makeState(makeRoot(7), log);
      const handler = bindFakes(new HydraniumGlspComputedBoundsActionHandler(), state, { hasPendingInitialRequest: () => false });

      const result = handler.execute(makeAction(3)) as Action[];

      expect(result).toEqual([]);
      expect(log.warn).toEqual([]);
      // 1 entry log + 1 stale-drop log
      expect(log.debug).toHaveLength(2);
      expect(log.debug[1]).toContain('ComputedBounds dropped (stale)');
   });

   it('records both action and model revisions in the log line so mismatches are diagnosable', () => {
      const log = makeLog();
      const state = makeState(makeRoot(12), log);
      const handler = bindFakes(new HydraniumGlspComputedBoundsActionHandler(), state, { hasPendingInitialRequest: () => true });

      handler.execute(makeAction(11));

      expect(log.warn[0]).toContain('action.revision=11');
      expect(log.warn[0]).toContain('model.revision=12');
   });
});
