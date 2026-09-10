/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The discrimination self-test for the `/glsp` battery: proof that each check
 * FAILS when the property it names is broken. One passing subject, then one
 * derivation per property breaking exactly that property, so a check that has
 * stopped asserting anything fails here instead of reading as coverage.
 *
 * The canary action type is a bare `{ kind }`, which is the whole point of the
 * slice being generic over `TAction`: the kit matches responses by `kind` and
 * nothing here needs an `@eclipse-glsp/*` type to exercise that.
 */

import { describe, expect, it } from 'vitest';
import { buildGlspChecks, type GlspConformanceDriver, type GlspFixture } from '../src/glsp/index.js';
import type { ConformanceCheck } from '../src/conformance-suite.js';

interface CanaryAction {
   readonly kind: string;
}

const REQUEST_MODEL = 'canaryRequestModel';
const MODEL_RESPONSE = 'canaryModelResponse';
const CREATE = 'canaryCreate';
const CREATE_RESPONSE = 'canaryCreateResponse';

/** Bounds the deliberately silent cases; the fake answers synchronously otherwise. */
const RESPONSE_TIMEOUT_MS = 40;

interface GlspCanaryDefects {
   /** `start` rejects instead of establishing a session. */
   readonly startRejects?: boolean;
   /** `RequestModel` is accepted and never answered. */
   readonly noModelResponse?: boolean;
   /** The create operation is accepted and never answered. */
   readonly noOperationResponse?: boolean;
   /** The model response arrives but the fixture's matcher rejects it. */
   readonly responseRejected?: boolean;
   /** The operation settles but the source model is unchanged. */
   readonly notMutated?: boolean;
}

/**
 * A GLSP server that satisfies every check in the `/glsp` battery, or fails
 * exactly the ones a {@link GlspCanaryDefects} flag names. Answers each
 * dispatched action with its paired response kind, which is all the round-trip
 * the battery observes.
 */
class CanaryGlspServer implements GlspConformanceDriver<CanaryAction> {
   private readonly delivered: CanaryAction[] = [];

   constructor(private readonly defects: GlspCanaryDefects = {}) {}

   async start(): Promise<void> {
      if (this.defects.startRejects) {
         throw new Error('the canary server established no client session');
      }
   }

   dispatch(action: CanaryAction): void {
      if (action.kind === REQUEST_MODEL && !this.defects.noModelResponse) {
         this.delivered.push({ kind: MODEL_RESPONSE });
      }
      if (action.kind === CREATE && !this.defects.noOperationResponse) {
         this.delivered.push({ kind: CREATE_RESPONSE });
      }
   }

   async nextAction<T extends CanaryAction = CanaryAction>(kind: string, timeoutMs: number = RESPONSE_TIMEOUT_MS): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      // Polls rather than registering a waiter because `dispatch` is
      // synchronous here, so the action is normally already delivered by the
      // time the check awaits — the loop exists only for the silent defects.
      for (;;) {
         const index = this.delivered.findIndex(action => action.kind === kind);
         if (index >= 0) {
            const [action] = this.delivered.splice(index, 1);
            return action as T;
         }
         if (Date.now() >= deadline) {
            throw new Error(`the canary delivered no ${kind} action`);
         }
         await new Promise(resolve => setTimeout(resolve, 5));
      }
   }

   dispose(): void {
      this.delivered.length = 0;
   }
}

function fixtureFor(defects: GlspCanaryDefects): GlspFixture<CanaryAction, CanaryGlspServer> {
   return {
      diagramType: 'canary',
      prepare: () => undefined,
      requestModel: () => ({ kind: REQUEST_MODEL }),
      expectedResponseKind: MODEL_RESPONSE,
      expectResponse: () => !defects.responseRejected,
      createOperation: {
         action: () => ({ kind: CREATE }),
         expectedResponseKind: CREATE_RESPONSE,
         expectMutated: () => !defects.notMutated
      }
   };
}

const START = 'start() initialises a client session';
const REQUEST_MODEL_CHECK = `RequestModel responds with ${MODEL_RESPONSE}`;
const CREATE_CHECK = 'create operation mutates the source model';

function batteryOver(defects: GlspCanaryDefects = {}): ConformanceCheck[] {
   const server = new CanaryGlspServer(defects);
   return buildGlspChecks<CanaryAction, CanaryGlspServer>({ connect: () => server, diagrams: [fixtureFor(defects)] });
}

async function failingChecks(defects: GlspCanaryDefects): Promise<string[]> {
   const failures: string[] = [];
   for (const check of batteryOver(defects)) {
      if (!check.body) {
         continue;
      }
      try {
         await check.body();
      } catch {
         failures.push(check.title);
      }
   }
   return failures;
}

function matching(titles: readonly string[], fragments: readonly string[]): string[] {
   return titles.filter(title => fragments.some(fragment => title.includes(fragment)));
}

describe('the /glsp battery discriminates', () => {
   it('passes every check against a conforming server', async () => {
      expect(await failingChecks({})).toEqual([]);
   });

   it('plans exactly the three checks the must-fail cases below name', () => {
      const titles = batteryOver().map(check => check.title);
      expect(titles).toHaveLength(3);
      expect(matching(titles, [START, REQUEST_MODEL_CHECK, CREATE_CHECK])).toHaveLength(3);
   });

   const canaries: ReadonlyArray<{ label: string; defects: GlspCanaryDefects; expected: readonly string[] }> = [
      // All three, and unavoidably so: every check in this battery drives
      // `start()` before anything else, so a session that never establishes
      // fails the lot. Declared in full rather than narrowed to the check that
      // NAMES start — the blast radius is what this table records, and writing
      // `[START]` here is the mis-declaration the strict count caught.
      { label: 'a start that rejects', defects: { startRejects: true }, expected: [START, REQUEST_MODEL_CHECK, CREATE_CHECK] },
      // Two checks, legitimately: the create check awaits the SAME initial
      // RequestModel response before dispatching its operation, so a server
      // that never answers the model request cannot reach the operation.
      { label: 'a RequestModel that is never answered', defects: { noModelResponse: true }, expected: [REQUEST_MODEL_CHECK, CREATE_CHECK] },
      { label: 'a model response the fixture rejects', defects: { responseRejected: true }, expected: [REQUEST_MODEL_CHECK] },
      { label: 'a create operation that is never answered', defects: { noOperationResponse: true }, expected: [CREATE_CHECK] },
      { label: 'a create operation that mutates nothing', defects: { notMutated: true }, expected: [CREATE_CHECK] }
   ];

   for (const canary of canaries) {
      it(`fails exactly its checks on ${canary.label}`, async () => {
         const failures = await failingChecks(canary.defects);
         expect(matching(failures, canary.expected)).toHaveLength(canary.expected.length);
         expect(failures).toHaveLength(canary.expected.length);
      });
   }
});
