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
   GLSPServerError,
   OperationHandlerRegistry,
   RequestModelAction,
   ServerModule,
   SourceModelStorage,
   ToolPaletteItemProvider
} from '@eclipse-glsp/server';
import { NodeFileSystem } from '@hydranium/core/node';
import { ServerMessageRenderer } from '@hydranium/core/messages';
import { HydraniumGlspAppModule, HydraniumGlspComputedBoundsActionHandler } from '@hydranium/glsp-server';
import { SOURCE_URI_MISSING } from '@hydranium/glsp-server/messages';
import { PALETTE_GATEWAY, PALETTE_TASK, PALETTE_TRANSITION } from '../../src/glsp/order-flow-tool-palette-item-provider.js';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { OrderFlowProcessDiagramConfiguration } from '../../src/glsp/order-flow-process-diagram-configuration.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../../src/language-server/order-flow-module.js';
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

   /**
    * The GLSP head renders through the SAME adopter binding as everything else.
    *
    * That claim is made in prose in the shared module and is otherwise
    * unverified anywhere: the framework's own suite proves the raise sites
    * render, and this example's rendering suite proves the LSP and data heads
    * share one pass — neither reaches the third head. GLSP is the one head whose
    * messages are rendered AT the raise site rather than at a carrier, so
    * "one binding covers it too" is a separate fact.
    */
   describe('server-side rendering reaches the GLSP head', () => {
      /** A locale that exists only here; the shipped catalogue carries no GLSP code. */
      const TEST_LOCALE = 'xx-AA';
      const RENDERED = 'AA: kein Dokument';

      /** Installs a catalogue holding the framework's GLSP code, on the one adopter slot. */
      class GlspCodeRenderer extends ServerMessageRenderer {
         protected override translationsFor(locale: string | undefined): Record<string, string> | undefined {
            return locale === TEST_LOCALE ? { [SOURCE_URI_MISSING.code]: RENDERED } : undefined;
         }
      }

      async function storageWithLocale(locale: string | undefined): Promise<SourceModelStorage> {
         const services = createOrderFlowServices(
            { ...NodeFileSystem },
            { extraSharedModules: [{ MessageRenderer: (tree: OrderFlowSharedServices) => new GlspCodeRenderer(tree) }] }
         );
         if (locale) {
            services.shared.ServerLocale.accept(locale);
         }
         harness = makeGlspHarness<OrderFlowGlspState>({
            serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
            diagramType: DIAGRAM_TYPE,
            appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
         });
         await harness.start();
         return harness.sessionContainer.get<SourceModelStorage>(SourceModelStorage);
      }

      /** The `sourceUri`-less request, which is the one raise site reachable with no workspace. */
      async function thrownMessage(locale: string | undefined): Promise<string> {
         const storage = await storageWithLocale(locale);
         const action = { kind: RequestModelAction.KIND, options: {} } as unknown as RequestModelAction;
         try {
            await storage.loadSourceModel(action);
         } catch (error: unknown) {
            if (error instanceof GLSPServerError) {
               return error.message;
            }
            throw error;
         }
         throw new Error('expected loadSourceModel to reject with a GLSPServerError');
      }

      it("renders a GLSP toast through the adopter's one MessageRenderer binding", async () => {
         expect(await thrownMessage(TEST_LOCALE)).toBe(RENDERED);
      });

      it('sends the English when no locale matches — the control on the row above', async () => {
         // Same renderer, no locale. Without it the row above would pass against
         // a GLSP head that never consulted the binding, since an unrendered
         // message and a rendered-but-uncatalogued one are the same string.
         expect(await thrownMessage(undefined)).toBe(SOURCE_URI_MISSING.text);
      });

      /**
       * The tool palette, which is a LABEL rather than an error.
       *
       * Worth its own assertion because it answers the question the two rows
       * above cannot: the seam's only other consumers are `GLSPServerError`
       * throws, so it LOOKS error-shaped. A toolbox going through the same one
       * binding is what shows it is not — and unlike the errors, these are
       * adopter-owned codes under `order-flow/`, so this is also the whole
       * adopter side of translating their own UI.
       */
      async function paletteLabels(locale: string | undefined): Promise<string[]> {
         const services = createOrderFlowServices({ ...NodeFileSystem });
         if (locale) {
            services.shared.ServerLocale.accept(locale);
         }
         harness = makeGlspHarness<OrderFlowGlspState>({
            serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
            diagramType: DIAGRAM_TYPE,
            appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
         });
         await harness.start();
         // `getItems` returns `MaybePromise`, so it is awaited rather than mapped
         // directly — an adopter overriding it with an async lookup is a
         // supported shape.
         const items = await harness.sessionContainer.get<ToolPaletteItemProvider>(ToolPaletteItemProvider).getItems();
         return items.map(item => item.label);
      }

      it('renders the tool palette in the locale, from the shipped catalogue', async () => {
         // The catalogue this example actually ships, not a test one — so this is
         // also the check that the four codes are in it.
         expect(await paletteLabels('de')).toEqual(expect.arrayContaining(['Aufgabe', 'Verzweigung', 'Übergang', 'Effekt']));
      });

      it('labels the palette in English with no locale — the control on the row above', async () => {
         const labels = await paletteLabels(undefined);

         expect(labels).toEqual(expect.arrayContaining([PALETTE_TASK.text, PALETTE_GATEWAY.text, PALETTE_TRANSITION.text]));
         expect(labels).not.toContain('Aufgabe');
      });
   });
});
