/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The kit's create check against a load that is still sending when the
 * operation is dispatched. The storage's settled hook runs on a 0ms timer, after
 * the load has answered and the kit has dispatched, and here it sends what an
 * external resubmit sends: a `requestBounds`, the create's response kind, and a
 * dirty state with reason `'external'`. Only the operation's own receipt, the
 * dirty state with reason `'operation'`, tells the two apart.
 */

import 'reflect-metadata';
import {
   type Action,
   type BindingTarget,
   CreateNodeOperation,
   RequestBoundsAction,
   RequestModelAction,
   ServerModule,
   SetDirtyStateAction,
   SOURCE_URI_ARG,
   type SourceModelStorage
} from '@eclipse-glsp/server';
import { buildGlspChecks, type GlspFixture } from '@hydranium/conformance/glsp';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowGlspStorage } from '../../src/glsp/order-flow-glsp-storage.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import { makeScratchWorkspaceHarness, WORKSPACE_FILES } from '../order-flow-harness.js';

type Driver = GlspHarness<OrderFlowGlspState>;

class LateSubmissionStorage extends OrderFlowGlspStorage {
   protected override onSourceModelSettled(): Action[] {
      return [
         RequestBoundsAction.create({ id: 'late-load-submission', type: 'graph' }),
         SetDirtyStateAction.create(false, { reason: 'external' })
      ];
   }
}

class LateSubmissionModule extends OrderFlowProcessDiagramModule {
   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return LateSubmissionStorage;
   }
}

let scratch: ScratchWorkspace | undefined;

afterEach(() => {
   scratch?.dispose();
   scratch = undefined;
});

async function connect(): Promise<Driver> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   return makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new LateSubmissionModule()),
      diagramType: 'order-flow-process',
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
}

/** Run the kit's create check for a fixture creating `nodeType`, with an `expectMutated` that asserts nothing. */
async function runCreateCheckFor(nodeType: string): Promise<void> {
   const fixture: GlspFixture<Action, Driver> = {
      diagramType: 'order-flow-process (late load submission)',
      prepare: () => undefined,
      requestModel: () => {
         if (!scratch) {
            throw new Error('requestModel called before connect seeded a workspace copy');
         }
         return RequestModelAction.create({ options: { [SOURCE_URI_ARG]: scratch.resolve(WORKSPACE_FILES.fulfillmentProcess) } });
      },
      expectedResponseKind: RequestBoundsAction.KIND,
      // Weak on purpose, so the receipt is all that can fail the check.
      createOperation: {
         action: () => CreateNodeOperation.create(nodeType),
         expectedResponseKind: RequestBoundsAction.KIND,
         expectMutated: () => true
      }
   };
   const check = buildGlspChecks<Action, Driver>({ connect, diagrams: [fixture] }).find(candidate =>
      candidate.title.includes('create operation')
   );
   if (!check?.body) {
      throw new Error('the kit planned no create check');
   }
   await check.body();
}

describe('the create check against a load still sending after the operation is dispatched', () => {
   it('fails an operation no handler accepts, though a late load submission sends the response kind', async () => {
      await expect(runCreateCheckFor('no-such-node-type')).rejects.toThrow(
         /receipt, a setDirtyState with reason 'operation', failed: .*either no operation ran or the session does not declare setDirtyState/
      );
   });

   it('passes an operation that runs', async () => {
      await expect(runCreateCheckFor(PROCESS_TASK_NODE_TYPE)).resolves.toBeUndefined();
   });
});
