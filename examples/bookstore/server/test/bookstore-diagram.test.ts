/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The starter diagram, run the way a client runs it: an in-process GLSP server
// opens a document. A create-node operation adds a node, and an undo and a redo
// take it out and put it back; every step must keep the nodes the document
// already had, and its comments, since the diagram writes the document from its
// AST, which carries none. A delete removes a node with the references to it, or
// an edge's reference. A reference into another document resolves, even
// when the diagram opened its document before the workspace was up, and draws
// an edge to an external node standing for its target. Each node is placed a
// row above its target, and a cycle does not stop the placing. A diagnostic
// reaches the diagram as a marker on its node.

import 'reflect-metadata';
import {
   type Action,
   CreateNodeOperation,
   DeleteElementOperation,
   GEdge,
   GModelFactory,
   GNode,
   ModelValidator,
   RedoAction,
   ServerModule,
   SetDirtyStateAction,
   UndoAction
} from '@eclipse-glsp/server';
import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { URI } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import {
   BOOKSTORE_DIAGRAM_TYPE,
   BOOKSTORE_EDGE_TYPE,
   BOOKSTORE_EXTERNAL_NODE_TYPE,
   BOOKSTORE_NODE_TYPE
} from '@hydranium/bookstore-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BookstoreDiagramModule } from '../src/glsp/bookstore/diagram-module.js';
import { BookstoreGModelFactory } from '../src/glsp/bookstore/gmodel-factory.js';
import type { BookstoreGlspState } from '../src/glsp/bookstore/state.js';
import { isBookstoreModel } from '../src/language-server/ast.js';
import { createServices } from '../src/node/services.js';

let workspace: ScratchWorkspace | undefined;
let diagram: GlspHarness<BookstoreGlspState> | undefined;

afterEach(() => {
   diagram?.dispose();
   workspace?.dispose();
   diagram = undefined;
   workspace = undefined;
});

/** Send `action` and wait for the dirty state the server answers it with, which it sends once the edit is written. */
async function send(harness: GlspHarness<BookstoreGlspState>, action: Action, reason: string): Promise<void> {
   const before = harness.actions.length;
   harness.dispatch(action);
   await waitFor(() => harness.actions.slice(before).some(sent => SetDirtyStateAction.is(sent) && sent.reason === reason), {
      message: `no '${reason}' dirty state`
   });
}

describe('Bookstore diagram', () => {
   it('creates a node after the existing ones, keeping their comments, and undoes and redoes it', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const original = '// keep this comment\nnode first -> second\n// about second\nnode second';
      const file = workspace.write('model.bookstore', original);
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);
      const uri = workspace.uri('model.bookstore');
      const text = (): string | undefined => shared.workspace.TextDocuments.get(uri)?.getText();

      await send(diagram, CreateNodeOperation.create(BOOKSTORE_NODE_TYPE), 'operation');
      const created = text();
      await send(diagram, UndoAction.create(), 'undo');
      const undone = text();
      await send(diagram, RedoAction.create(), 'redo');

      expect({ created, undone, redone: text() }).toEqual({
         created: `${original}\nnode Node`,
         undone: original,
         redone: `${original}\nnode Node`
      });
   });

   it('deletes a node with the references to it, and an edge with its reference, undoably', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const original = 'node first -> second\nnode second\nnode third -> first';
      const file = workspace.write('model.bookstore', original);
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      const harness = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      diagram = harness;
      await harness.start();
      await harness.openDocument(file);
      const uri = workspace.uri('model.bookstore');
      const text = (): string | undefined => shared.workspace.TextDocuments.get(uri)?.getText();
      const idOf = (type: string, index: number): string => harness.state.root.children.filter(child => child.type === type)[index].id;

      await send(harness, DeleteElementOperation.create([idOf(BOOKSTORE_NODE_TYPE, 1)]), 'operation');
      const nodeDeleted = text();
      await send(harness, UndoAction.create(), 'undo');
      const undone = text();
      // The edge third -> first.
      await send(harness, DeleteElementOperation.create([idOf(BOOKSTORE_EDGE_TYPE, 1)]), 'operation');

      expect({ nodeDeleted, undone, edgeDeleted: text() }).toEqual({
         nodeDeleted: 'node first\nnode third -> first',
         undone: original,
         edgeDeleted: 'node first -> second\nnode second\nnode third'
      });
   });

   it('deletes the drawn node of a repeated name, keeping the references the remaining node resolves', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const file = workspace.write('model.bookstore', 'node first -> second\nnode first\nnode second -> first');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      const harness = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      diagram = harness;
      await harness.start();
      await harness.openDocument(file);

      await send(harness, DeleteElementOperation.create([harness.state.root.children[0].id]), 'operation');

      expect(shared.workspace.TextDocuments.get(workspace.uri('model.bookstore'))?.getText()).toBe('node first\nnode second -> first');
   });

   it('deletes a node, keeping the references another document declares the name for', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      workspace.write('other.bookstore', 'node second');
      const file = workspace.write('model.bookstore', 'node first -> second\nnode second');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      const harness = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      diagram = harness;
      await harness.start();
      await harness.openDocument(file);

      await send(harness, DeleteElementOperation.create([harness.state.root.children[1].id]), 'operation');

      expect(shared.workspace.TextDocuments.get(workspace.uri('model.bookstore'))?.getText()).toBe('node first -> second');
   });

   it("draws a repeated name once, as its first node with that node's edge", async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const file = workspace.write('model.bookstore', 'node a\nnode a -> b\nnode b');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);

      // The first `a` references nothing, so no edge, and both nodes share a row.
      const children = diagram.state.root.children;
      expect(children.map(child => ({ type: child.type, position: child instanceof GNode ? child.position : undefined }))).toEqual([
         { type: BOOKSTORE_NODE_TYPE, position: { x: 0, y: 0 } },
         { type: BOOKSTORE_NODE_TYPE, position: { x: 200, y: 0 } }
      ]);
   });

   it("draws a node named like another node's label or edge", async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const file = workspace.write('model.bookstore', 'node a -> b\nnode b\nnode a_name\nnode a_target');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);

      expect(diagram.state.root.children.map(child => child.type)).toEqual([
         BOOKSTORE_NODE_TYPE,
         BOOKSTORE_NODE_TYPE,
         BOOKSTORE_NODE_TYPE,
         BOOKSTORE_NODE_TYPE,
         BOOKSTORE_EDGE_TYPE
      ]);
   });

   it('draws a reference into another document as an edge to one external node', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      workspace.write('declaring.bookstore', 'node second');
      const file = workspace.write('referencing.bookstore', 'node first -> second\nnode third -> second');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);

      const children = diagram.state.root.children;
      const external = children.find(child => child.type === BOOKSTORE_EXTERNAL_NODE_TYPE);
      expect(children.map(child => child.type)).toEqual([
         BOOKSTORE_NODE_TYPE,
         BOOKSTORE_NODE_TYPE,
         BOOKSTORE_EXTERNAL_NODE_TYPE,
         BOOKSTORE_EDGE_TYPE,
         BOOKSTORE_EDGE_TYPE
      ]);
      expect(external?.children[0]).toMatchObject({ text: 'second (declaring.bookstore)' });
      // The two referencing nodes side by side in one row, their target in the next.
      expect(children.filter(child => child instanceof GNode).map(node => node.position)).toEqual([
         { x: 0, y: 0 },
         { x: 200, y: 0 },
         { x: 0, y: 90 }
      ]);
      const targets = children.filter(child => child instanceof GEdge).map(edge => edge.targetId);
      expect(targets).toEqual([external?.id, external?.id]);
   });

   it('draws one external node per document when two documents declare the same name', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      workspace.write('one.bookstore', 'node second');
      workspace.write('two.bookstore', 'node second');
      const file = workspace.write('referencing.bookstore', 'node first -> second\nnode third -> second');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      const harness = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      diagram = harness;
      await harness.start();
      await harness.openDocument(file);
      // A name resolves to one node per document, so point each reference at a
      // different document's node the way a qualified reference would.
      const [first, third] = harness.state.sourceRoot.nodes;
      for (const [node, declaring] of [
         [first, 'one.bookstore'],
         [third, 'two.bookstore']
      ] as const) {
         const declared = shared.workspace.LangiumDocuments.getDocument(URI.parse(workspace.uri(declaring)))?.parseResult.value;
         if (!node.target || !isBookstoreModel(declared)) {
            throw new Error(`no reference from ${node.name} or no model in ${declaring}`);
         }
         Object.defineProperty(node.target, 'ref', { value: declared.nodes[0] });
      }
      harness.sessionContainer.get<GModelFactory>(GModelFactory).createModel();

      const children = harness.state.root.children;
      const externals = children.filter(child => child.type === BOOKSTORE_EXTERNAL_NODE_TYPE);
      expect(externals.map(external => external.children[0])).toMatchObject([
         { text: 'second (one.bookstore)' },
         { text: 'second (two.bookstore)' }
      ]);
      const targets = children.filter(child => child instanceof GEdge).map(edge => edge.targetId);
      expect(targets).toEqual(externals.map(external => external.id));
   });

   it('places each node a row above its target, cutting a cycle', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const file = workspace.write('cycle.bookstore', 'node a -> b\nnode b -> a\nnode c -> a');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);

      // The walk from `a` meets `a` again at `b`, so `b` ranks first; `c` references `a`.
      const rows = diagram.state.root.children.filter(child => child instanceof GNode).map(node => node.position.y / 90);
      expect(rows).toEqual([1, 2, 0]);
   });

   it('ranks a chain longer than the call stack is deep', () => {
      // The ranking alone, since a document this long takes seconds to parse and link.
      class Ranking extends BookstoreGModelFactory {
         rankChain(targetOf: ReadonlyMap<string, string>, ids: readonly string[]): Map<string, number> {
            return this.rank(targetOf, ids);
         }
      }
      const ids = Array.from({ length: 100_000 }, (_, i) => `n${i}`);
      const targetOf = new Map(ids.slice(0, -1).map((id, i) => [id, ids[i + 1]]));

      const ranks = new Ranking().rankChain(targetOf, ids);

      expect({ first: ranks.get(ids[0]), beforeLast: ranks.get(ids[ids.length - 2]) }).toEqual({ first: ids.length - 1, beforeLast: 1 });
   });

   it('keeps no route the client reports, which it computes before it sizes the nodes', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const file = workspace.write('loop.bookstore', 'node a -> a');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      const harness = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      diagram = harness;
      await harness.start();
      await harness.openDocument(file);
      const edge = (): GEdge | undefined => harness.state.root.children.find(child => child instanceof GEdge);
      const edgeId = edge()?.id ?? '';

      // A self-reference's loop as the client routes it around a node not yet sized.
      const corners = [
         { x: 19, y: -0.75 },
         { x: 19, y: 19 },
         { x: -0.75, y: 19 }
      ];
      const routes = [{ elementId: edgeId, newRoutingPoints: [{ x: 0, y: 0 }, ...corners, { x: 0, y: 0 }] }];
      await harness.answerBoundsRequest({ routes });

      expect(edge()?.routingPoints).toEqual([]);
   });

   it('marks a diagnostic on the node it is about', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      const file = workspace.write('duplicate.bookstore', 'node first\nnode first');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);

      // A workspace brought up programmatically does not validate; an editor's open does.
      const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
      await shared.workspace.DocumentBuilder.build([document], { validation: true });

      // The repeated name's warning, on the one node the diagram keeps for both.
      const markers = await diagram.sessionContainer.get<ModelValidator>(ModelValidator).validate([diagram.state.root]);
      expect(markers.map(marker => ({ elementId: marker.elementId, kind: marker.kind }))).toEqual([
         { elementId: diagram.state.root.children[0].id, kind: 'warning' }
      ]);
   });

   it('resolves a cross-document reference in a document opened before the workspace is up', async () => {
      workspace = makeScratchWorkspace({ prefix: 'bookstore-diagram-' });
      workspace.write('declaring.bookstore', 'node second');
      const file = workspace.write('referencing.bookstore', 'node first -> second');
      const { shared } = createServices();
      diagram = makeGlspHarness<BookstoreGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      // The open waits for the workspace. One that did not would have linked
      // within this timer against a workspace holding only itself, and the
      // bring-up does not relink it. Its budget covers the bring-up as well.
      const opening = diagram.openDocument(file, 10_000);
      await new Promise(resolve => setTimeout(resolve, 200));
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      await opening;

      expect(diagram.state.sourceRoot?.nodes[0].target?.ref?.name).toBe('second');
   });
});
