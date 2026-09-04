/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `@hydranium/conformance/glsp` slice — protocol conformance for the GLSP
 * head, generic over the adopter's action type `TAction`. The kit imports NO
 * `@eclipse-glsp/*` types: the FIXTURE supplies the native actions
 * (`requestModel()`, `createOperation.action()`) and the kit matches responses
 * by `kind` (a `string`) via the driver's `nextAction`.
 *
 * The driver port (`GlspConformanceDriver<TAction>`) is the minimal
 * `start` / `dispatch` / `nextAction` surface that `@hydranium/glsp-server/
 * testing`'s `GlspHarness` satisfies with no adapter. Grammar-specific setup
 * and assertions (seeding a source root for the light path, reading the
 * mutated source model) are the adopter's via `prepare` / `expectResponse` /
 * `createOperation.expectMutated`, which receive the CONCRETE driver `TDriver`
 * — so the port stays grammar-agnostic while the adopter keeps full access to
 * its harness.
 */

import assert from 'node:assert/strict';
import type { Harness } from '@hydranium/protocol/testing';
import type { ConformanceCheck } from '../conformance-suite.js';

/**
 * The GLSP driver port — a live GLSP server driven through the action
 * round-trip. Generic over the adopter action type `TAction` so the kit names
 * no `@eclipse-glsp/*` type. `@hydranium/glsp-server/testing`'s `GlspHarness`
 * satisfies it structurally with `TAction = Action`. `extends Harness` gives
 * the kit the universal `dispose()` teardown.
 */
export interface GlspConformanceDriver<TAction> extends Harness {
   /** Drive `initialize` + `initializeClientSession`; resolve once the session exists. */
   start(): Promise<void>;
   /** Send an action to the server. Fire-and-forget (GLSP `process` is `void`). */
   dispatch(action: TAction): void;
   /** Resolve with the next captured action whose `kind` matches; reject on timeout. */
   nextAction<T extends TAction = TAction>(kind: string, timeoutMs?: number): Promise<T>;
}

/**
 * Opt-in create-operation spec. The adopter supplies the operation action, the
 * expected response kind it settles with, and a matcher reading the mutated
 * source model off the concrete driver.
 */
export interface GlspCreateOperationSpec<TAction, TDriver extends GlspConformanceDriver<TAction>> {
   /**
    * Construct the create operation to dispatch.
    *
    * Receives the driver, and is called AFTER the initial `requestModel` has
    * settled — so the loaded model is available here. Two things depend on that:
    *
    * - **Capturing a "before" snapshot.** {@link expectMutated} gets no
    *   pre-operation state, so an adopter that wants a delta rather than an
    *   absolute count records it here, in its own closure.
    * - **Operations that need real element ids.** A `CreateEdgeOperation` names
    *   a source and target from the index, which do not exist until the model is
    *   loaded.
    */
   readonly action: (driver: TDriver) => TAction;
   /** The action kind the server settles the operation with (e.g. a re-`RequestBounds` for client-laid-out diagrams). */
   readonly expectedResponseKind: string;
   /**
    * Returns whether the source model gained the element — the adopter reads its
    * concrete state off `driver`.
    *
    * **Receives no pre-operation snapshot of its own**, because the kit owns no
    * source-model type and cannot capture one generically. An adopter wanting a
    * delta rather than an absolute count records the before-state in
    * {@link GlspCreateOperationSpec.action}, which does get the driver and does
    * run after the model has loaded.
    *
    * Sticking to an absolute count is fine too, with one caveat: it couples the
    * fixture to its input document, so a fixture whose input was MUTATED by an
    * earlier check silently expects the wrong number. Give each check pristine
    * input, or take the delta route above.
    */
   readonly expectMutated: (driver: TDriver) => boolean;
}

/**
 * Per-diagram-type GLSP fixture, generic over the adopter action type and the
 * concrete driver. The `prepare` hook covers both fidelities: LIGHT seeds a
 * source root directly (`driver.seedSourceRoot(...)`); FAITHFUL no-ops and lets
 * the `requestModel` action carry a source URI a real storage loads.
 */
export interface GlspFixture<TAction, TDriver extends GlspConformanceDriver<TAction>> {
   /**
    * **Title only** — the label every check for this fixture is tagged with.
    *
    * It is NOT the diagram type the server runs: `connect` supplies that to the
    * harness. Appending a fidelity or document suffix here is what makes two
    * fixtures over ONE diagram type read apart in the report. Nothing validates
    * this string, so treat it as free-form and make it descriptive; a value that
    * is only ever displayed is checked by nothing.
    */
   readonly diagramType: string;
   /** Seed (light) or no-op (faithful) after `start`, before the first `requestModel` dispatch. */
   readonly prepare: (driver: TDriver) => void | Promise<void>;
   /**
    * Construct the `RequestModel` action (light: bare; faithful: carrying a
    * source URI).
    *
    * A THUNK, called per check and always AFTER `connect` — so a faithful fixture
    * may read a root that `connect` just created, which is how an adopter gives
    * every check pristine on-disk input. The `/data` and `/lsp` slices get the
    * same per-check resolution from `ConformanceModel`'s deferrable fields.
    */
   readonly requestModel: () => TAction;
   /** The action kind the server responds to `requestModel` with (e.g. `RequestBoundsAction.KIND`). */
   readonly expectedResponseKind: string;
   /** Optional matcher over the response action — the adopter digs into the projected GModel (the kit owns no GModel types). */
   readonly expectResponse?: (response: TAction) => boolean;
   /** Opt-in: a create operation that must mutate the source model. */
   readonly createOperation?: GlspCreateOperationSpec<TAction, TDriver>;
}

/** Options for `runGlspConformance`. */
export interface GlspConformanceOptions<TAction, TDriver extends GlspConformanceDriver<TAction>> {
   /**
    * Establish a freshly-wired GLSP driver (NOT started — the kit drives
    * `start()` per check). Called once per check for isolation; the kit
    * disposes it. The faithful path must build the workspace here first, so
    * storage has something to load.
    */
   readonly connect: () => TDriver | Promise<TDriver>;
   /** Per-diagram-type fixtures. */
   readonly diagrams: ReadonlyArray<GlspFixture<TAction, TDriver>>;
   /** Suite title override. Default `'conformance: glsp'`. */
   readonly suiteTitle?: string;
}

/**
 * Build the GLSP check battery — per diagram type: `start()` resolves;
 * `RequestModel` responds with the expected kind (+ optional `expectResponse`
 * matcher); and an OPT-IN create-operation check (absent ⇒ `it.skip` with a
 * named reason). Each check connects a fresh driver, drives `start` + the
 * fixture's `prepare`, and disposes the driver. Exported for the kit's own
 * unit tests; adopters call `runGlspConformance`.
 */
export function buildGlspChecks<TAction, TDriver extends GlspConformanceDriver<TAction>>(
   options: GlspConformanceOptions<TAction, TDriver>
): ConformanceCheck[] {
   const { connect } = options;
   const checks: ConformanceCheck[] = [];

   for (const diagram of options.diagrams) {
      const tag = `[${diagram.diagramType}]`;

      checks.push({
         title: `start() initialises a client session ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               await driver.start();
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `RequestModel responds with ${diagram.expectedResponseKind} ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               await driver.start();
               await diagram.prepare(driver);
               driver.dispatch(diagram.requestModel());
               const response = await driver.nextAction(diagram.expectedResponseKind);
               if (diagram.expectResponse) {
                  assert.ok(diagram.expectResponse(response), `expectResponse was false for the ${diagram.expectedResponseKind} response`);
               }
            } finally {
               driver.dispose();
            }
         }
      });

      const operation = diagram.createOperation;
      if (operation) {
         checks.push({
            title: `create operation mutates the source model ${tag}`,
            body: async () => {
               const driver = await connect();
               try {
                  await driver.start();
                  await diagram.prepare(driver);
                  driver.dispatch(diagram.requestModel());
                  await driver.nextAction(diagram.expectedResponseKind);
                  driver.dispatch(operation.action(driver));
                  await driver.nextAction(operation.expectedResponseKind);
                  assert.ok(
                     operation.expectMutated(driver),
                     'expectMutated was false — the create operation did not mutate the source model'
                  );
               } finally {
                  driver.dispose();
               }
            }
         });
      } else {
         checks.push({
            title: `create operation mutates the source model ${tag}`,
            skipReason: 'fixture supplied no createOperation'
         });
      }
   }

   return checks;
}
