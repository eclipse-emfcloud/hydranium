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
 * supplies is the transport and the page's element, and nothing about the
 * diagram itself. `mountGlspDiagram` from `@hydranium/glsp-client` supplies
 * what a shell would: GLSP's standalone modules, the framework's binder,
 * framing, resize tracking, the server's messages on the canvas and touch
 * input.
 *
 * What is left here is this page's own: the client over the head's connection,
 * and the report line that counts what the GLSP head sent.
 */

import { EditorContextService, GEdge, type GParentElement, GNode } from '@eclipse-glsp/client';
import { glspConnection, type GlspDiagramMount, HydraniumGlspClient, mountGlspDiagram } from '@hydranium/glsp-client';
import { initializeOrderFlowProcessDiagramContainer } from '@hydranium/example-order-flow-client/lib/diagram/order-flow-process-diagram-module';
import { PROCESS_DIAGRAM_TYPE } from '@hydranium/example-order-flow-protocol';
import type { Container } from 'inversify';
import { describeError, type Logger, SystemClock } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc/browser';
import { requireElement } from './dom.js';
// LAST, so esbuild emits these rules after `@eclipse-glsp/client`'s and they win
// on equal specificity — the same ordering the VS Code diagram bundle depends
// on. The sheet is the diagram's own, shared with every host; the page supplies
// only the mount point's size, which lives in `index.html`.
import '@hydranium/example-order-flow-client/style/diagram.css';

/**
 * The id of the element sprotty renders into, which the mount also uses as the
 * GLSP client session's id.
 */
export const PROCESS_DIAGRAM_ELEMENT_ID = 'order-flow-process-diagram';

/**
 * How long to wait for the graph before saying that nothing is coming.
 *
 * A loaded outcome means the server answered `RequestModelAction`; it does not
 * mean anything was drawn. A model whose element types have no view
 * registration renders as nothing at all — sprotty's fallback is a featureless
 * element and `MissingView` — so the absence has to be looked for rather than
 * waited out. Generous, like the diagnostics deadline: this reports a fact, it
 * does not fail anything.
 */
const RENDER_DEADLINE_MS = 15_000;

/**
 * Mount the diagram and report what ended up on the page.
 *
 * Resolves with a one-line report of the same shape as the data head's line, so
 * the three heads read as three answers about one store rather than as three
 * unrelated widgets, and with the mount, whose edits in flight the page's
 * guards read.
 *
 * The logger carries the framework's client classes under a tag of the page's
 * own, so a load failure the page itself reports does not read as a line the
 * worker sent.
 */
export async function mountProcessDiagram(
   connection: MessageConnection,
   sourceUri: string,
   onReport: (report: string) => void,
   logger: Logger
): Promise<{ report: string; mount: GlspDiagramMount }> {
   // No `connection.listen()` here: `BaseJsonrpcGLSPClient.start` calls it, and
   // a second call throws. GLSP's client sends message types built by its own
   // copy of `vscode-jsonrpc`, which this connection's copy rejects unless they
   // go by method name.
   const glspClient = new HydraniumGlspClient({ id: PROCESS_DIAGRAM_ELEMENT_ID, connectionProvider: glspConnection(connection) });
   const mount = await mountGlspDiagram({
      mount: requireElement(PROCESS_DIAGRAM_ELEMENT_ID),
      diagramType: PROCESS_DIAGRAM_TYPE,
      sourceUri,
      glspClient,
      initializeDiagramContainer: initializeOrderFlowProcessDiagramContainer,
      logger
   });
   // Reported here and not left to the poll, which would wait out its deadline
   // and then blame an unregistered element type; when the dispatcher is what
   // failed, this line is the only report the page shows.
   const { container, loadOutcome } = mount;
   if (loadOutcome.status === 'failed') {
      return { report: `failed: ${describeError(loadOutcome.error)}`, mount };
   }
   // The mount resolves once the model is framed, so the report this resolves
   // with is the only signal a caller needs: everything observable about the
   // diagram — the elements in the DOM and the viewport they are drawn in — is
   // settled by the time the line appears.
   //
   // The DOM is consulted ONCE, here, and for a different question than the
   // report answers: whether anything was drawn at all. That failure — a model
   // whose element types have no view registration — is invisible in the model,
   // which is fully populated either way, so it needs the one measurement the
   // model cannot make. Every later reading is of the model; see `countGraph`.
   const report = (await waitForAnyRenderedShape())
      ? describeGraph(countGraph(container.get(EditorContextService).modelRoot))
      : nothingDrawnReport();
   trackGraphCount(container, onReport);
   return { report, mount };
}

/**
 * Count the nodes and edges in the graph the GLSP head sent.
 *
 * **Off the MODEL, not off the DOM, and the difference is not a detail.**
 * sprotty culls: `ShapeView.isVisible` tests each element against the canvas
 * bounds, so a node outside them is absent from the document while very much
 * present in the model. A DOM count therefore reports the VIEWPORT, and the
 * number moves when nothing about the model has — measured, shrinking the
 * diagram pane takes the same five-node graph through three drawn nodes to zero.
 * Beside a data-head line that is a statement about the store, a viewport
 * measurement labelled `GLSP` reads as the head having lost elements.
 *
 * Edges hide this rather than sharing it, which is what makes it a trap: edge
 * views do not cull on bounds, so the edge count stays right while the node
 * count drops, and a wrong report looks like a node-specific defect.
 *
 * Recursive, because containment is the adopter's choice: this graph is flat,
 * and a nested one would have a count that silently omitted whatever a
 * compartment held. `GParentElement` rather than `GModelElement` because that is
 * the class `children` is declared on, and every child is itself one — sprotty
 * keeps no separate leaf type.
 */
function countGraph(root: Readonly<GParentElement>): { nodes: number; edges: number } {
   let nodes = 0;
   let edges = 0;
   for (const child of root.children) {
      // `GNode` is sprotty's `SNodeImpl` under a GLSP name, so this also counts
      // the shape subclasses an adopter registers for anchoring — a gateway is a
      // `DiamondNode`, and a check against a narrower class would miss it.
      if (child instanceof GNode) {
         nodes++;
      } else if (child instanceof GEdge) {
         edges++;
      }
      const nested = countGraph(child);
      nodes += nested.nodes;
      edges += nested.edges;
   }
   return { nodes, edges };
}

/**
 * Keep the graph report current as the model changes.
 *
 * **A one-shot report is worse than none once anything can be created**: the
 * line names five nodes, so a reader who then adds a task from the palette sees
 * a count that is now wrong sitting beside a layout report that updated — and
 * the honest reading of that pair is that the GLSP head has stopped answering.
 *
 * Read in the handler and not on the next frame: the event fires once the new
 * root is in place, so the model is current immediately. Only a DOM count has to
 * wait for sprotty to patch.
 */
function trackGraphCount(container: Container, onReport: (report: string) => void): void {
   const editorContext = container.get(EditorContextService);
   editorContext.onModelRootChanged(root => onReport(describeGraph(countGraph(root))));
}

/**
 * Whether any shape reached the document, or `false` at
 * {@link RENDER_DEADLINE_MS}.
 *
 * WHETHER rather than how many, because a count off the DOM is a count of what
 * is currently in view — see `countGraph`. The existence question is the one the
 * document can answer and the model cannot.
 *
 * `.sprotty-node` is the class sprotty's own views put on a drawn shape — the
 * same one the shared stylesheet selects on, so a rename would break the
 * appearance too rather than this check alone.
 *
 * Polled rather than observed: the question is "is there a graph NOW", asked
 * repeatedly. A `MutationObserver` answers "did something change", which a
 * diagram that finished rendering before this ran would never say.
 */
async function waitForAnyRenderedShape(): Promise<boolean> {
   const waited = new SystemClock().stopwatch();
   for (;;) {
      const mount = document.getElementById(PROCESS_DIAGRAM_ELEMENT_ID);
      if ((mount?.querySelectorAll('.sprotty-node').length ?? 0) > 0) {
         return true;
      }
      if (waited.elapsedMs >= RENDER_DEADLINE_MS) {
         return false;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
   }
}

function nothingDrawnReport(): string {
   return (
      `nothing drawn after ${RENDER_DEADLINE_MS / 1000}s — the server answered the model request but no shape ` +
      'reached the page, which is what an unregistered element type looks like'
   );
}

function describeGraph(graph: { nodes: number; edges: number }): string {
   return `${graph.nodes} node(s) and ${graph.edges} edge(s)`;
}
