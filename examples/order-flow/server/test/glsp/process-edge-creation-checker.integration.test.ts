/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The edge-creation feedback the cursor is driven by, asserted over the ACTION
 * the client actually sends.
 *
 * `RequestCheckEdgeAction` → `CheckEdgeResultAction` is the whole seam: the
 * transition hint is marked `dynamic`, so while an edge is being drawn the
 * client asks the server per hover and colours the cursor from the answer.
 * Driving it as an action rather than as mouse input is deliberate — synthetic
 * pointer events on the real canvas hit whichever child element happens to be
 * under the cursor, so a pixel-driven test of this reports on hit-testing rather
 * than on the rule.
 *
 * The rules themselves are covered on the text side by
 * `test/process-transition-rules.test.ts`. What is only observable here is
 * whether they are REACHED: `bindEdgeCreationChecker` is an optional binding
 * that GLSP defaults to nothing, and with `dynamic: true` and no checker every
 * target reads as valid right up to the drop that discards it.
 *
 * Each rejection is paired with the acceptance that proves the checker is live.
 * `isValid: false` is also what a missing binding would produce for nothing at
 * all — so a suite of refusals alone cannot tell "refused correctly" from "never
 * asked", which is the one composition mistake it looks like it would catch.
 */

import 'reflect-metadata';
import { type CheckEdgeResultAction, CreateEdgeOperation, RequestCheckEdgeAction, ServerModule } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { afterEach, describe, expect, it } from 'vitest';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { PROCESS_TRANSITION_EDGE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import type { ProcessModel } from '../../src/language-server/ast.js';
import { makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';
const PROCESS_FILE = 'orders/fulfillment.process';

let harness: GlspHarness<OrderFlowGlspState> | undefined;
let scratch: ScratchWorkspace | undefined;

async function openDiagram(): Promise<GlspHarness<OrderFlowGlspState>> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })],
      additionalClientActionKinds: ['checkEdgeTargetResult']
   });
   await harness.start();
   await harness.openDocument(workspace.resolve(PROCESS_FILE));
   return harness;
}

/** The id the server emitted for a flow node, via the real index. */
function idOf(driver: GlspHarness<OrderFlowGlspState>, name: string): string {
   const node = driver.state.sourceRoot.nodes.find(candidate => candidate.name === name);
   if (!node) {
      throw new Error(`no flow node named ${name}`);
   }
   return driver.state.index.createId(node);
}

/**
 * Ask the server whether `source` may START an edge.
 *
 * A `RequestCheckEdgeAction` with no target routes to `isValidSource` instead of
 * `isValidTarget` — a separate branch of the checker, and the one the client
 * consults while the user is still picking where the edge begins.
 */
async function checkSource(driver: GlspHarness<OrderFlowGlspState>, source: string): Promise<boolean> {
   driver.dispatch(RequestCheckEdgeAction.create({ edgeType: PROCESS_TRANSITION_EDGE_TYPE, sourceElement: idOf(driver, source) }));
   const result = await driver.nextAction<CheckEdgeResultAction>('checkEdgeTargetResult');
   return result.isValid;
}

/** Ask the server whether `source -> target` may be drawn, as the client does. */
async function check(driver: GlspHarness<OrderFlowGlspState>, source: string, target: string): Promise<boolean> {
   driver.dispatch(
      RequestCheckEdgeAction.create({
         edgeType: PROCESS_TRANSITION_EDGE_TYPE,
         sourceElement: idOf(driver, source),
         targetElement: idOf(driver, target)
      })
   );
   const result = await driver.nextAction<CheckEdgeResultAction>('checkEdgeTargetResult');
   return result.isValid;
}

describe('order-flow .process edge-creation feedback', () => {
   afterEach(() => {
      harness?.dispose();
      harness = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   it('allows a pair the process does not already join', async () => {
      const driver = await openDiagram();

      // `Ship -> Cancel` is absent from the fixture, and both ends are flow
      // nodes. This is the acceptance every rejection below is paired against.
      expect(await check(driver, 'Ship', 'Cancel')).toBe(true);
   });

   it('accepts any flow node as a source, and nothing else', async () => {
      const driver = await openDiagram();

      // `isValidSource` is a SEPARATE branch, reached only when the client asks
      // without a target — which is what it does while the user is still picking
      // where the edge starts. A checker that answered only `isValidTarget`
      // would pass every other test here and still make the first click of every
      // edge do nothing.
      expect(await checkSource(driver, 'Pick')).toBe(true);
      expect(await checkSource(driver, 'PaymentOk')).toBe(true);
      // A node that already has an outgoing transition is still a valid SOURCE;
      // only the pair is constrained.
      expect(await checkSource(driver, 'Pay')).toBe(true);
   });

   it('refuses a transition that would return to its own source', async () => {
      const driver = await openDiagram();

      expect(await check(driver, 'Pick', 'Pick')).toBe(false);
      // Paired acceptance, so the refusal cannot be a checker that says no to
      // everything — or one that was never asked.
      expect(await check(driver, 'Pick', 'Cancel')).toBe(true);
   });

   it('refuses a transition the process already declares', async () => {
      const driver = await openDiagram();

      // The fixture declares `Pick -> Ship`.
      expect(await check(driver, 'Pick', 'Ship')).toBe(false);
      // The same source, a free target: so it is the PAIR being refused rather
      // than the source being unusable.
      expect(await check(driver, 'Pick', 'Cancel')).toBe(true);
   });

   it('refuses in the direction it is declared, and allows the reverse', async () => {
      const driver = await openDiagram();

      // A transition is directed, so `Ship -> Pick` is a different edge from the
      // declared `Pick -> Ship` and must stay available. Without this the
      // duplicate rule could be comparing an unordered pair and nothing above
      // would notice.
      expect(await check(driver, 'Pick', 'Ship')).toBe(false);
      expect(await check(driver, 'Ship', 'Pick')).toBe(true);
   });

   it('rejects the operation too, not only the feedback', async () => {
      const driver = await openDiagram();
      const transitionsBefore = driver.state.sourceRoot.transitions.length;

      // The checker is FEEDBACK — only consulted for a `dynamic` hint, and only
      // by a client that chooses to ask. The handler has to repeat the rule or
      // it is a UI convention rather than a property of the model.
      driver.dispatch(
         CreateEdgeOperation.create({
            elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
            sourceElementId: idOf(driver, 'Pick'),
            targetElementId: idOf(driver, 'Ship')
         })
      );
      const submission = await driver.nextModelSubmission({ timeoutMs: 250, rejectOnTimeout: false });
      expect(submission).toBeUndefined();
      expect(driver.state.sourceRoot.transitions).toHaveLength(transitionsBefore);

      // And the valid equivalent still lands, which is what proves the handler
      // is bound at all rather than silently absent.
      driver.dispatch(
         CreateEdgeOperation.create({
            elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
            sourceElementId: idOf(driver, 'Ship'),
            targetElementId: idOf(driver, 'Cancel')
         })
      );
      await driver.nextModelSubmission();
      expect(pairsOf(driver.state.sourceRoot)).toContainEqual(['Ship', 'Cancel']);
   });
});

const pairsOf = (root: ProcessModel): string[][] =>
   root.transitions.map(transition => [transition.source.$refText, transition.target.$refText]);
