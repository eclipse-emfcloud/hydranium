/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Composition invariants of the `.process` diagram module — the things that are
 * true of the assembled DI container rather than of any one handler.
 *
 * Both assertions here exist because the alternative was a prose claim in a doc
 * comment, and prose claims about DI do not fail when they stop being true.
 */

import 'reflect-metadata';
import {
   ActionHandlerRegistry,
   ChangeBoundsOperation,
   ComputedBoundsAction,
   DeleteElementOperation,
   OperationHandlerRegistry,
   ServerModule
} from '@eclipse-glsp/server';
import { HydraniumGlspAppModule, HydraniumGlspComputedBoundsActionHandler } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { OrderFlowProcessDiagramConfiguration } from '../../src/glsp/order-flow-process-diagram-configuration.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { makeServices } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

let harness: GlspHarness<OrderFlowGlspState> | undefined;

/**
 * Compose the real container without opening a document. Nothing here needs a
 * workspace — the assertions are about bindings, and
 * `OperationHandlerRegistryInitializer` builds every operation handler at
 * `InitializeClientSession`, before any `RequestModelAction`.
 */
async function composeSession(): Promise<GlspHarness<OrderFlowGlspState>> {
   const services = makeServices();
   harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   await harness.start();
   return harness;
}

describe('order-flow .process diagram composition', () => {
   afterEach(() => {
      harness?.dispose();
      harness = undefined;
   });

   it('registers exactly one computed-bounds handler, the framework one', async () => {
      const local = await composeSession();
      const handlers = local.sessionContainer.get(ActionHandlerRegistry).get(ComputedBoundsAction.KIND);

      // `binding.rebind` rather than `binding.add`. GLSP's dispatcher runs every
      // handler registered for a kind, and the computed-bounds path calls
      // `submitModelDirectly`, which does not bump the model revision — so an
      // appended second handler also passes its revision check. That applies
      // bounds twice, submits twice per layout pass, and lets upstream's
      // unfiltered `applyRoute` run first, defeating the under-routed-edge
      // filter the framework override exists to provide.
      expect(handlers).toHaveLength(1);
      expect(handlers[0]).toBeInstanceOf(HydraniumGlspComputedBoundsActionHandler);
   });

   it('pairs the movable hints with the ChangeBounds handler, in both directions', async () => {
      const local = await composeSession();
      const operations = local.sessionContainer.get(OperationHandlerRegistry);
      const configuration = new OrderFlowProcessDiagramConfiguration();

      // The pairing this test enforces, in both directions: a hint declaring a
      // capability with no matching handler yields a client palette tool whose
      // operation the server rejects, and a bound handler no hint advertises is
      // unreachable from the canvas. `repositionable` / `resizable` are on
      // because `OrderFlowChangeBoundsOperationHandler` is bound and the
      // `.layout` grammar gives a drag somewhere to be persisted; unbind the
      // handler and the hints have to come off with it, or the drag is dropped
      // on the next reload.
      const hasChangeBounds = operations.getOperationHandler(ChangeBoundsOperation.create([])) !== undefined;
      const claimsMovable = [
         ...configuration.shapeTypeHints.map(hint => hint.repositionable || hint.resizable),
         ...configuration.edgeTypeHints.map(hint => hint.repositionable || hint.routable)
      ].some(Boolean);
      expect(claimsMovable).toBe(hasChangeBounds);

      // Control for the assertion above: the registry lookup really does resolve
      // a handler for a kind that is wired, so an empty ChangeBounds lookup would
      // mean "not registered" rather than "lookup always empty".
      expect(operations.getOperationHandler(DeleteElementOperation.create([]))).toBeDefined();
   });
});
