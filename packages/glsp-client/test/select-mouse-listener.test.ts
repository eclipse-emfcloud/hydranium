/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import {
   type Action,
   BringToFrontAction,
   type CommandExecutionContext,
   createFeatureSet,
   GEdge,
   GGraph,
   type GModelElement,
   GNode,
   GRoutingHandle,
   SelectAction,
   SelectCommand,
   SelectionService
} from '@eclipse-glsp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HydraniumSelectMouseListener } from '../src/select-mouse-listener';

/** A left button press with no modifier, or with the platform's multi-select one. */
function click(options: { multi?: boolean } = {}): MouseEvent {
   return { button: 0, ctrlKey: options.multi === true, metaKey: false } as MouseEvent;
}

function makeElement<T extends GModelElement>(element: T, id: string, features: symbol[]): T {
   element.id = id;
   element.type = 'element';
   element.features = createFeatureSet(features);
   return element;
}

/** A graph with two nodes and an edge carrying one routing handle. */
function makeGraph(): { graph: GGraph; one: GNode; two: GNode; edge: GEdge; handle: GRoutingHandle } {
   const graph = makeElement(new GGraph(), 'root', GGraph.DEFAULT_FEATURES);
   const one = makeElement(new GNode(), 'one', GNode.DEFAULT_FEATURES);
   const two = makeElement(new GNode(), 'two', GNode.DEFAULT_FEATURES);
   const edge = makeElement(new GEdge(), 'edge', GEdge.DEFAULT_FEATURES);
   edge.sourceId = one.id;
   edge.targetId = two.id;
   graph.add(one);
   graph.add(two);
   graph.add(edge);
   // After the edge is in the graph: a child is indexed through its root.
   const handle = makeElement(new GRoutingHandle(), 'handle', GRoutingHandle.DEFAULT_FEATURES);
   edge.add(handle);
   return { graph, one, two, edge, handle };
}

/**
 * GLSP's real selection service with its injected collaborators stubbed. The
 * feedback it dispatches is what writes each element's `selected` flag, and it
 * is NOT applied here: that is the state a click lands in while the previous
 * click's selection is still pending, which is the hazard under test.
 */
function makeSelectionService(): SelectionService {
   const service = new SelectionService();
   Object.assign(service, {
      feedbackDispatcher: { registerFeedback: () => undefined },
      lazyInjector: { getAll: () => [] },
      logger: { log: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
   });
   return service;
}

/** Run every select action of `actions` through GLSP's real `SelectCommand`,
 *  in order. The command reads only the context's root. */
function applySelections(service: SelectionService, graph: GGraph, actions: (Action | Promise<Action>)[]): void {
   const context = { root: graph } as unknown as CommandExecutionContext;
   for (const action of actions) {
      if (SelectAction.is(action)) {
         new SelectCommand(action, service).execute(context);
      }
   }
}

describe('HydraniumSelectMouseListener', () => {
   let listener: HydraniumSelectMouseListener;
   let service: SelectionService;
   let model: ReturnType<typeof makeGraph>;

   beforeEach(() => {
      // `isCtrlOrCmd` reads the user agent to pick the modifier key.
      vi.stubGlobal('window', { navigator: { userAgent: 'Linux' } });
      listener = new HydraniumSelectMouseListener();
      service = makeSelectionService();
      model = makeGraph();
   });

   afterEach(() => {
      vi.unstubAllGlobals();
   });

   it('a plain click landing before the previous selection applied replaces it', () => {
      const first = listener.mouseDown(model.one, click());
      const second = listener.mouseDown(model.two, click());
      applySelections(service, model.graph, [...first, ...second]);
      expect(service.getSelectedElementIDs()).toEqual(['two']);
   });

   it('a plain click brings the clicked element to the front, as GLSP does', () => {
      const actions = listener.mouseDown(model.one, click());
      expect(actions).toContainEqual(BringToFrontAction.create(['one']));
   });

   it('a click on the canvas landing before the previous selection applied clears it', () => {
      const select = listener.mouseDown(model.one, click());
      const canvas = [...listener.mouseDown(model.graph, click()), ...listener.mouseUp(model.graph, click())];
      applySelections(service, model.graph, [...select, ...canvas]);
      expect(service.getSelectedElementIDs()).toEqual([]);
   });

   it('a Ctrl/Cmd-click adds to the selection', () => {
      const first = listener.mouseDown(model.one, click());
      const second = listener.mouseDown(model.two, click({ multi: true }));
      applySelections(service, model.graph, [...first, ...second]);
      expect(service.getSelectedElementIDs()).toEqual(['one', 'two']);
   });

   it("a click on a routing handle keeps the handle's edge selected", () => {
      applySelections(service, model.graph, [SelectAction.setSelection(['edge'])]);
      // The flag applied, so sprotty's list would hold the edge but for its handle-parent exclusion.
      model.edge.selected = true;
      const actions = listener.mouseDown(model.handle, click());
      applySelections(service, model.graph, actions);
      expect(service.getSelectedElementIDs()).toEqual(['edge', 'handle']);
   });
});
