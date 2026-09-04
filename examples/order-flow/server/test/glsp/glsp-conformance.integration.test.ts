/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `@hydranium/conformance/glsp` slice run against this example's real
 * `.process` diagram server.
 *
 * # What the run exercises
 *
 * The kit's create-operation check drives a **field-level** write path end to
 * end: the operation mutates the AST, the recording command diffs the transfer
 * projection, and `ReconcilingMultiDocumentGlspState.updateSourceModel` persists
 * the patch through `ModelService.update`. A mutation the `.process` serializer
 * cannot express fails here rather than at runtime.
 *
 * The two fixtures are a **matched pair over the layout overlay**, not two
 * copies of one run:
 *
 * - `fulfillment.process` has a sibling `fulfillment.layout` covering four of
 *   its five flow nodes, so its `expectResponse` proves persisted bounds reach
 *   the wire.
 * - `returns.process` has no `.layout` file beside it, so its `expectResponse`
 *   proves every node is left to client layout.
 *
 * Neither assertion is meaningful without the other: a factory that ignored the
 * block entirely would pass the second fixture, and one that invented bounds for
 * every node would pass the first. Together they pin `needsClientLayout` staying
 * `true` while bounds override only where they exist.
 *
 * # Why each check gets a pristine scratch copy
 *
 * The create-operation check writes to disk — through the serializer, and a
 * rebuild also runs the integrity rules, whose default silent mode persists
 * repairs. Pointing the suite at the committed `order-flow-workspace` would
 * rewrite it, so every `connect` seeds a fresh throwaway copy.
 *
 * That is only possible because `GlspFixture.requestModel` is a **thunk**: it is
 * called per check, after `connect`, so it can read the root that `connect` just
 * made. `data-conformance.integration.test.ts` shares ONE scratch directory
 * across its whole battery instead, which is a choice rather than a limit — the
 * `/data` and `/lsp` slices take `ConformanceModel.uri` as a `Deferred`, so a
 * thunk there gets the same per-check isolation.
 *
 * # What the controls on these fixtures show
 *
 * A conformance suite is the one place where the adopter supplies the input and
 * the kit supplies the assertion, so nothing in the suite's own text says the
 * input ever reached the assertion. Each of these is worth re-running after a
 * change to a fixture, and each names WHICH checks it reddens:
 *
 * - **Point the `returns` fixture at `fulfillment.process`** (count adjusted, so
 *   only uniformity can fail) → exactly its `RequestModel` check. So the "every
 *   node is unpositioned" assertion genuinely notices bounds; it is not
 *   vacuously true of any graph.
 * - **Early-return from the factory's `applyBounds`** → exactly the `fulfillment`
 *   `RequestModel` check, with `returns` still green. So the overlay is what the
 *   first fixture reads, and the two fixtures are independent rather than two
 *   spellings of one run.
 * - **Unbind the create-flow-node handlers** (`OrderFlowCreateTaskOperationHandler`
 *   and `OrderFlowCreateGatewayOperationHandler`) → exactly the two
 *   create-operation checks, each as a timeout waiting for a SECOND
 *   `requestBounds`. That the first one is already consumed is the part worth
 *   having: it shows the create checks await the operation's own submission
 *   rather than re-reading the initial load's.
 * - **Share one scratch copy across the battery instead of rotating** → nothing.
 *   A control that cannot redden is itself a result: the rotation below closes an
 *   ORDER-DEPENDENCY footgun rather than a current failure, because the only
 *   mutating check is each fixture's last and the two fixtures touch different
 *   files.
 */

import 'reflect-metadata';
import {
   type Action,
   CreateNodeOperation,
   type GNode,
   RequestBoundsAction,
   RequestModelAction,
   ServerModule,
   SOURCE_URI_ARG
} from '@eclipse-glsp/server';
import { runGlspConformance, type GlspFixture } from '@hydranium/conformance/vitest';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { afterAll } from 'vitest';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { PROCESS_GATEWAY_NODE_TYPE, PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import { makeScratchWorkspaceHarness, WORKSPACE_FILES } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

type Driver = GlspHarness<OrderFlowGlspState>;

/** `fulfillment.process`: tasks Pay / Pick / Ship / Cancel plus gateway PaymentOk. */
const FULFILLMENT_NODE_COUNT = 5;
/** `returns.process`: tasks Receive / Restock / Scrap plus gateway Restockable. */
const RETURNS_NODE_COUNT = 4;
/** `node Pay at 40, 100 size 160, 60` — the one layout entry read back off the wire. */
const PAY_BOUNDS = { position: { x: 40, y: 100 }, size: { width: 160, height: 60 } } as const;

/**
 * The scratch copy the CURRENT check runs over.
 *
 * Rotated rather than pooled: `connect` disposes the previous copy and seeds a
 * new one, so at most one temp directory is alive and every check sees pristine
 * input. That matters because `expectMutated` below can only state an ABSOLUTE
 * expectation — the kit hands it the driver and no pre-operation snapshot — so a
 * copy carrying a previous check's `NewTask` would make the count wrong.
 */
let scratch: ScratchWorkspace | undefined;

afterAll(() => {
   scratch?.dispose();
   scratch = undefined;
});

/** The absolute path of a workspace file inside the current scratch copy. */
function scratchPath(relativePath: string): string {
   if (!scratch) {
      throw new Error('scratchPath called before connect seeded a workspace copy');
   }
   return scratch.resolve(relativePath);
}

/**
 * Boot the real GLSP container over a pristine copy of the sample workspace.
 *
 * The Langium side goes through `makeScratchWorkspaceHarness` (the
 * editor-equivalent `initialize` / `initialized` pair over a fresh copy) rather
 * than the eager `buildWorkspaceProgrammatically` convenience, for the reason
 * `order-flow-harness.ts` documents: this workspace's project descriptors
 * are a strict subset of its model files, and the eager helper would build
 * everything twice and hide a regression in the init path.
 */
async function connect(): Promise<Driver> {
   scratch?.dispose();
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   return makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
}

/** The flow-node children of a submitted graph, both kinds, in emission order. */
function flowNodes(response: Action): GNode[] {
   const children = (response as RequestBoundsAction).newRoot.children ?? [];
   return children.filter((child): child is GNode => child.type === PROCESS_TASK_NODE_TYPE || child.type === PROCESS_GATEWAY_NODE_TYPE);
}

/**
 * `.process` lays out client-side (`needsClientLayout: true`, unchanged by the
 * `.layout` overlay — persisted bounds are an overlay, not an authority), so the
 * server answers `RequestModel` with a `RequestBoundsAction` carrying the
 * projected GModel. Same kind settles a successful operation.
 */
const RESPONSE_KIND = RequestBoundsAction.KIND;

/**
 * The process WITH a `.layout` file. Ids are flow-node names here because the
 * index keys named elements by name, which is what lets the matcher below name
 * `Pay` and `Cancel` instead of reaching into the index.
 */
const fulfillmentFixture: GlspFixture<Action, Driver> = {
   diagramType: `${DIAGRAM_TYPE} (fulfillment, with layout)`,
   prepare: () => undefined, // faithful: the real storage loads via the source URI below
   requestModel: () => RequestModelAction.create({ options: { [SOURCE_URI_ARG]: scratchPath(WORKSPACE_FILES.fulfillmentProcess) } }),
   expectedResponseKind: RESPONSE_KIND,
   expectResponse: response => {
      const nodes = flowNodes(response);
      const pay = nodes.find(node => node.id === 'Pay');
      const cancel = nodes.find(node => node.id === 'Cancel');
      if (nodes.length !== FULFILLMENT_NODE_COUNT || !pay || !cancel) {
         return false;
      }
      // The persisted entry reached the wire, position AND size.
      const positioned = pay.position?.x === PAY_BOUNDS.position.x && pay.position?.y === PAY_BOUNDS.position.y;
      const sized = pay.size?.width === PAY_BOUNDS.size.width && pay.size?.height === PAY_BOUNDS.size.height;
      // `Cancel` is deliberately absent from the layout file, so it must NOT carry
      // Pay's bounds. Compared against Pay rather than against a hardcoded
      // sentinel: GLSP's builder default is the origin with a -1 size, and the
      // assertion is about the ABSENCE of a persisted position, not about which
      // sentinel upstream happens to use.
      const unpositioned = cancel.position?.x !== PAY_BOUNDS.position.x || cancel.position?.y !== PAY_BOUNDS.position.y;
      return positioned && sized && unpositioned;
   },
   createOperation: {
      action: () => CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE),
      expectedResponseKind: RESPONSE_KIND,
      // Absolute, not a delta — the kit gives `expectMutated` no pre-operation
      // snapshot. Safe only because `connect` rotates in a pristine copy.
      expectMutated: driver => driver.state.sourceRoot.nodes.length === FULFILLMENT_NODE_COUNT + 1
   }
};

/**
 * The process WITHOUT a `.layout` file — the control for the fixture above.
 * Every node must be left to client layout, which is the normal state for a
 * hand-authored `.process` file and the reason the layout file is optional.
 */
const returnsFixture: GlspFixture<Action, Driver> = {
   diagramType: `${DIAGRAM_TYPE} (returns, no layout)`,
   prepare: () => undefined,
   requestModel: () => RequestModelAction.create({ options: { [SOURCE_URI_ARG]: scratchPath(WORKSPACE_FILES.returnsProcess) } }),
   expectedResponseKind: RESPONSE_KIND,
   expectResponse: response => {
      const nodes = flowNodes(response);
      if (nodes.length !== RETURNS_NODE_COUNT) {
         return false;
      }
      // Every node carries the same builder default, i.e. nothing was overlaid.
      // A factory that invented bounds per node — or one that leaked the sibling
      // document's layout — produces distinct positions here.
      const positions = new Set(nodes.map(node => `${node.position?.x ?? 'none'},${node.position?.y ?? 'none'}`));
      return positions.size === 1;
   },
   createOperation: {
      action: () => CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE),
      expectedResponseKind: RESPONSE_KIND,
      // The create path must not assume a layout document exists: this process
      // has no `.layout` file at all, and the handler still has to append a task.
      expectMutated: driver => driver.state.sourceRoot.nodes.length === RETURNS_NODE_COUNT + 1
   }
};

runGlspConformance<Action, Driver>({
   suiteTitle: 'conformance: glsp (order-flow .process)',
   connect,
   diagrams: [fulfillmentFixture, returnsFixture]
});
