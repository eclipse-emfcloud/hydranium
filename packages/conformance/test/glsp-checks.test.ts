/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildGlspChecks, type GlspConformanceDriver, type GlspFixture } from '../src/glsp/index.js';

type Act = { readonly kind: string };
type Drv = GlspConformanceDriver<Act>;

// Never invoked — these tests inspect the planned check list, not the bodies.
const connect = (): Drv => {
   throw new Error('connect must not be called when only inspecting the plan');
};

const base: GlspFixture<Act, Drv> = {
   diagramType: 'd',
   prepare: () => undefined,
   requestModel: () => ({ kind: 'requestModel' }),
   expectedResponseKind: 'requestBounds'
};

const withOperation: GlspFixture<Act, Drv> = {
   ...base,
   createOperation: {
      action: () => ({ kind: 'createNode' }),
      expectedResponseKind: 'requestBounds',
      expectMutated: () => true
   }
};

describe('buildGlspChecks', () => {
   it('runs the create-operation check when the fixture supplies a createOperation', () => {
      const op = buildGlspChecks({ connect, diagrams: [withOperation] }).find(check => check.title.includes('create operation'));
      expect(op?.body).toBeDefined();
      expect(op?.skipReason).toBeUndefined();
   });

   it('skips the create-operation check with a named reason when none is supplied', () => {
      const op = buildGlspChecks({ connect, diagrams: [base] }).find(check => check.title.includes('create operation'));
      expect(op?.body).toBeUndefined();
      expect(op?.skipReason).toBe('fixture supplied no createOperation');
   });

   it('plans three checks per diagram type', () => {
      // start + RequestModel + create-operation (run or skipped) per diagram.
      expect(buildGlspChecks({ connect, diagrams: [base] })).toHaveLength(3);
      expect(buildGlspChecks({ connect, diagrams: [base, withOperation] })).toHaveLength(6);
   });

   it('builds the create operation from the driver, after the model has loaded', async () => {
      // `action` receives the driver so a fixture can read the loaded model —
      // to capture a "before" snapshot (`expectMutated` gets none of its own) or
      // to name real element ids, as a CreateEdgeOperation must. Both need the
      // initial RequestModel to have settled first, which is the ordering
      // asserted here.
      const seen: string[] = [];
      const driver: Drv = {
         start: async () => {
            seen.push('start');
         },
         dispatch: action => seen.push(`dispatch:${action.kind}`),
         nextAction: async kind => {
            seen.push(`await:${kind}`);
            return { kind } as never;
         },
         dispose: () => seen.push('dispose')
      };

      let sawDriver = false;
      const check = buildGlspChecks({
         connect: () => driver,
         diagrams: [
            {
               ...base,
               createOperation: {
                  action: given => {
                     sawDriver = given === driver;
                     seen.push('build-operation');
                     return { kind: 'createNode' };
                  },
                  expectedResponseKind: 'requestBounds',
                  expectMutated: () => true
               }
            }
         ]
      }).find(candidate => candidate.title.includes('create operation'));

      await check?.body?.();

      expect(sawDriver).toBe(true);
      expect(seen).toEqual([
         'start',
         'dispatch:requestModel',
         'await:requestBounds',
         // The operation is constructed HERE — after the load settled, not before.
         'build-operation',
         'dispatch:createNode',
         'await:requestBounds',
         'dispose'
      ]);
   });
});
