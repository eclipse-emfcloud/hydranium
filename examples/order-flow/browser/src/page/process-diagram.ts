/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page end of the worker's GLSP channel: a diagram rendered with no Node
 * runtime, no backend and no shell.
 *
 * The diagram DEFINITION is not here. It is
 * `@hydranium/example-order-flow-client`'s, the same module the Theia and
 * VS Code shells mount — which is the point of the slice: what a browser host
 * supplies is the transport and the container's host modules, and nothing about
 * the diagram itself.
 *
 * # What replaces the shell
 *
 * A Theia or VS Code integration contributes a `GLSPClient` and a widget. Here
 * `STANDALONE_MODULE_CONFIG` supplies GLSP's own plain-webapp modules and the
 * client is built by hand over the transferred port — three lines, because
 * `BaseJsonrpcGLSPClient` takes any `ConnectionProvider` and a `MessageConnection`
 * over a `MessagePort` is one.
 *
 * Upstream's `GLSPWebWorkerProvider` looks like the piece for this and is not:
 * it constructs the worker itself, which would be a second worker with a second
 * Langium store, and reads the worker object rather than a port. See
 * `head-channels.ts`.
 */

import {
   DiagramLoader,
   EditorContextService,
   FitToScreenAction,
   InitializeCanvasBoundsAction,
   type GLSPActionDispatcher,
   type IDiagramOptions,
   STANDALONE_MODULE_CONFIG,
   TYPES,
   createDiagramOptionsModule
} from '@eclipse-glsp/client';
import { BaseJsonrpcGLSPClient } from '@eclipse-glsp/protocol';
import { initializeOrderFlowProcessDiagramContainer } from '@hydranium/example-order-flow-client/lib/diagram/order-flow-process-diagram-module';
import { PROCESS_DIAGRAM_TYPE } from '@hydranium/example-order-flow-client/lib/diagram/order-flow-process-diagram-types';
import { Container, ContainerModule } from 'inversify';
import { BrowserMessageReader, BrowserMessageWriter, createMessageConnection } from 'vscode-jsonrpc/browser';
// LAST, so esbuild emits these rules after `@eclipse-glsp/client`'s and they win
// on equal specificity — the same ordering the VS Code diagram bundle depends
// on. The sheet is the diagram's own, shared with every host; the page supplies
// only the mount point's size, which lives in `index.html`.
import '@hydranium/example-order-flow-client/style/diagram.css';

/**
 * The id of the element sprotty renders into.
 *
 * One constant, not two: `configureDiagramOptions` derives `ViewerOptions.baseDiv`
 * from `clientId`, so the document's element id and the GLSP client session id
 * are the same string whether or not anyone intended that. Spelling it once is
 * what stops a rename of the div from producing an empty page with no error —
 * sprotty logs a missing base div and carries on.
 */
export const PROCESS_DIAGRAM_ELEMENT_ID = 'order-flow-process-diagram';

/**
 * How long to wait for the graph before saying that nothing is coming.
 *
 * `DiagramLoader.load` resolving means the server answered `RequestModelAction`;
 * it does not mean anything was drawn. A model whose element types have no view
 * registration renders as nothing at all — sprotty's fallback is a featureless
 * element and `MissingView` — so the absence has to be looked for rather than
 * waited out. Generous, like the diagnostics deadline: this reports a fact, it
 * does not fail anything.
 */
const RENDER_DEADLINE_MS = 15_000;

/**
 * The one host service a plain page has to say it does not provide.
 *
 * GLSP's context-menu module resolves `TYPES.IContextMenuService` through a
 * provider that falls back to a no-op AND warns on the console every time a
 * container is built. Binding the no-op explicitly says the same thing without
 * the warning, and that matters more here than it looks: the browser console is
 * this host's only log — the worker posts its failures there and the language
 * server's lines arrive over the LSP channel — so a recurring warning that means
 * nothing trains the reader to ignore the place real failures appear.
 *
 * A page could instead bind a real menu; there is nothing to put in one yet.
 */
const noContextMenuModule = new ContainerModule(bind => {
   bind(TYPES.IContextMenuService).toConstantValue({ show: () => undefined });
});

/**
 * Build the GLSP client, the diagram container and load the model.
 *
 * Resolves with a one-line report of what ended up on the page — the same shape
 * as the data head's line, so the three heads read as three answers about one
 * store rather than as three unrelated widgets.
 */
export async function mountProcessDiagram(glspPort: MessagePort, sourceUri: string, onReport: (report: string) => void): Promise<string> {
   // No `connection.listen()` here: `BaseJsonrpcGLSPClient.start` calls it, and
   // a second call throws. The reader also assigns `port.onmessage`, which
   // starts the port implicitly.
   const connection = createMessageConnection(new BrowserMessageReader(glspPort), new BrowserMessageWriter(glspPort));
   const glspClient = new BaseJsonrpcGLSPClient({ id: PROCESS_DIAGRAM_ELEMENT_ID, connectionProvider: connection });

   const diagramOptions: IDiagramOptions = {
      clientId: PROCESS_DIAGRAM_ELEMENT_ID,
      diagramType: PROCESS_DIAGRAM_TYPE,
      glspClientProvider: async () => glspClient,
      sourceUri
   };

   // The diagram definition is appended LAST by
   // `initializeOrderFlowProcessDiagramContainer`, after the host's modules —
   // sprotty's model and view registries throw on a duplicate key, so whichever
   // module registers an element type first wins by making the second throw.
   const container = initializeOrderFlowProcessDiagramContainer(
      new Container(),
      createDiagramOptionsModule(diagramOptions),
      STANDALONE_MODULE_CONFIG,
      noContextMenuModule
   );

   await container.get(DiagramLoader).load();
   // Framed BEFORE the shapes are counted, so the report this resolves with is
   // the only signal a caller needs: everything observable about the diagram —
   // the elements in the DOM and the viewport they are drawn in — is settled by
   // the time the line appears. Counting first would leave a window in which the
   // nodes are on the page at the load-time viewport and the fit is still
   // pending, and a pointer gesture started in it is measured against one
   // viewport and applied in another.
   await frameDiagram(container);
   const report = describeRenderedDiagram(await waitForRenderedShapes());
   trackCanvasSize(container);
   trackShapeCount(container, onReport);
   return report;
}

/**
 * Keep the rendered-shape report current as the model changes.
 *
 * **A one-shot report is worse than none once anything can be created**: the line
 * says `rendered 5 node(s) and 4 edge(s)`, so a reader who then adds a task from
 * the palette sees a count that is now wrong sitting beside a layout report that
 * updated — and the honest reading of that pair is that the GLSP head has stopped
 * answering. It is the only one of the three head reports that was written once
 * and never revised.
 *
 * Counted off the DOM rather than off the model root the event carries, so the
 * report keeps meaning what it says: it is a statement about what reached the
 * page, and the number that matters is the one culling and view registration have
 * already had their say over. A count taken from the model would report five
 * nodes for a diagram drawing two.
 *
 * The count is taken on the next frame, not in the handler: the event fires when
 * the root is swapped in and sprotty patches the DOM afterwards, so reading
 * immediately reports the PREVIOUS render — off by exactly one operation, which
 * is the least obvious way for a counter to be wrong.
 */
function trackShapeCount(container: Container, onReport: (report: string) => void): void {
   container.get(EditorContextService).onModelRootChanged(() => {
      requestAnimationFrame(() => {
         const mount = document.getElementById(PROCESS_DIAGRAM_ELEMENT_ID);
         if (mount === null) {
            return;
         }
         onReport(
            describeRenderedDiagram({
               nodes: mount.querySelectorAll('.sprotty-node').length,
               edges: mount.querySelectorAll('g.sprotty-edge').length
            })
         );
      });
   });
}

/**
 * Keep sprotty's idea of its canvas in step with the element it draws into.
 *
 * **sprotty updates its canvas bounds on `window.resize` and on nothing else** —
 * `Viewer.onWindowResize` is the only producer of `InitializeCanvasBoundsAction`
 * after the initial load. A page whose diagram sits in a pane the reader can drag
 * therefore has to tell it, and the failure if it does not is the culling one
 * again rather than a stale number: `ShapeView.isVisible` tests each element
 * against the canvas the model believes it has, so widening the pane leaves the
 * new space empty while narrowing it makes shapes vanish that are plainly on
 * screen. Both read as a server sending a partial model.
 *
 * A `ResizeObserver` rather than a callback from the divider code, so a size
 * change from any cause is covered — the window, a divider, or the reader zooming
 * the browser. GLSP's own standalone example makes the same accommodation for its
 * resizable app card.
 *
 * The bounds are read in PAGE coordinates, matching what `Viewer` computes:
 * sprotty maps pointer positions through them, so a viewport-relative rect would
 * offset every click by the page's scroll.
 */
function trackCanvasSize(container: Container): void {
   const mount = document.getElementById(PROCESS_DIAGRAM_ELEMENT_ID);
   if (mount === null) {
      return;
   }
   const dispatcher = container.get<GLSPActionDispatcher>(TYPES.IActionDispatcher);
   // Skipped for a zero box, which is what an element hidden by a divider dragged
   // to its limit reports: a canvas of zero culls the whole model, and the next
   // real size would have to arrive before anything came back.
   new ResizeObserver(() => {
      const box = mount.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
         return;
      }
      void dispatcher.dispatch(
         InitializeCanvasBoundsAction.create({
            x: box.left + window.scrollX,
            y: box.top + window.scrollY,
            width: box.width,
            height: box.height
         })
      );
   }).observe(mount);
}

/**
 * How much canvas to leave around the model, in model units before the zoom.
 *
 * Enough that the outermost node's border is not the edge of the pane, and no
 * more: this padding is subtracted from the space the fit has to work with, so a
 * generous value buys white space by shrinking the diagram.
 */
const FIT_PADDING = 24;

/**
 * Frame the loaded model in its canvas.
 *
 * **A page has to do this itself, and nothing upstream does it for it.** sprotty
 * leaves the viewport at `scale(1) translate(0,0)` after a load, which anchors
 * the model at the canvas's top-left corner — so a model wider than the pane is
 * cut off at the right edge with no indication that anything is missing, and one
 * narrower than it sits in a corner with the rest of the canvas empty. A shell
 * frames its diagram widget on open; this is the equivalent, and it is why the
 * `.layout` fixture can place nodes by RANK rather than by what happens to fit in
 * a pane of one particular width.
 *
 * `maxZoom: 1` so this only ever zooms OUT. Without it a small model is
 * magnified to fill the canvas, which makes a two-node diagram render at four
 * times the size of a ten-node one and turns the zoom level into a function of
 * how much is on screen.
 *
 * The bounds it measures come from the hidden rendering pass inside `load`, so
 * there is nothing further to wait for — a fit dispatched before that pass has
 * nothing to measure and silently leaves the viewport where it was.
 *
 * **The root's children are named EXPLICITLY, and the obvious
 * `FitToScreenAction.create([])` does not work here.** An empty id list is
 * sprotty's own spelling for "fit everything" — it is what `Ctrl+Shift+F` sends —
 * but it selects the elements by falling back to every bounds-aware element in
 * the index, labels and edges and the graph root included, and combining that set
 * over this model yields a degenerate box: measured, the viewport lands at
 * `scale(20) translate(NaN,NaN)`, which culls every shape and leaves a blank
 * canvas that no console message explains. Naming the top-level elements skips
 * the fallback entirely. The keybinding remains broken, since it does not go
 * through here.
 */
async function frameDiagram(container: Container): Promise<void> {
   const root = container.get(EditorContextService).modelRoot;
   const ids = root.children.map(child => child.id);
   const dispatcher = container.get<GLSPActionDispatcher>(TYPES.IActionDispatcher);
   await dispatcher.dispatch(FitToScreenAction.create(ids, { padding: FIT_PADDING, maxZoom: 1, animate: false }));
}

/**
 * Count the shapes under the mount point once there are any, or give up at
 * {@link RENDER_DEADLINE_MS}.
 *
 * `.sprotty-node` / `.sprotty-edge` are the classes sprotty's own views put on
 * the drawn shape — the same ones the shared stylesheet selects on, so a rename
 * would break the appearance too rather than this check alone.
 *
 * Edges are matched as `g.sprotty-edge`, not bare: an edge's group AND the
 * `<path>` inside it both carry the class, so the unqualified selector reports
 * every edge twice. Nodes carry it once, on the shape.
 *
 * Polled rather than observed: the question is "is there a graph NOW", asked
 * repeatedly. A `MutationObserver` answers "did something change", which a
 * diagram that finished rendering before this ran would never say.
 */
async function waitForRenderedShapes(): Promise<{ nodes: number; edges: number } | undefined> {
   const deadline = performance.now() + RENDER_DEADLINE_MS;
   for (;;) {
      const mount = document.getElementById(PROCESS_DIAGRAM_ELEMENT_ID);
      const nodes = mount?.querySelectorAll('.sprotty-node').length ?? 0;
      const edges = mount?.querySelectorAll('g.sprotty-edge').length ?? 0;
      if (nodes > 0) {
         return { nodes, edges };
      }
      if (performance.now() >= deadline) {
         return undefined;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
   }
}

function describeRenderedDiagram(shapes: { nodes: number; edges: number } | undefined): string {
   if (shapes === undefined) {
      return (
         `nothing drawn after ${RENDER_DEADLINE_MS / 1000}s — the server answered the model request but no shape ` +
         'reached the page, which is what an unregistered element type looks like'
      );
   }
   return `rendered ${shapes.nodes} node(s) and ${shapes.edges} edge(s)`;
}
