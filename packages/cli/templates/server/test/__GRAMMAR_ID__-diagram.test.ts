// The starter diagram, run the way a client runs it: an in-process GLSP server
// opens a document. A create-node operation adds a node, and an undo and a redo
// take it out and put it back; every step must keep the nodes the document
// already had, and its comments, since the diagram writes the document from its
// AST, which carries none. A reference into another document draws no edge,
// since the graph holds no node for its target, but resolves, even when the
// diagram opened its document before the workspace was up.

import 'reflect-metadata';
import { type Action, CreateNodeOperation, RedoAction, ServerModule, SetDirtyStateAction, UndoAction } from '@eclipse-glsp/server';
import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { waitFor } from '@hydranium/protocol/testing';
import { __GRAMMAR_ID_CONST___DIAGRAM_TYPE, __GRAMMAR_ID_CONST___NODE_TYPE } from '__PROTOCOL_PACKAGE__';
import { afterEach, describe, expect, it } from 'vitest';
import { __GRAMMAR__DiagramModule } from '../src/glsp/__GRAMMAR_ID__/diagram-module.js';
import type { __GRAMMAR__GlspState } from '../src/glsp/__GRAMMAR_ID__/state.js';
import { createServices } from '../src/node/services.js';

let workspace: ScratchWorkspace | undefined;
let diagram: GlspHarness<__GRAMMAR__GlspState> | undefined;

afterEach(() => {
   diagram?.dispose();
   workspace?.dispose();
   diagram = undefined;
   workspace = undefined;
});

/** Send `action` and wait for the dirty state the server answers it with, which it sends once the edit is written. */
async function send(harness: GlspHarness<__GRAMMAR__GlspState>, action: Action, reason: string): Promise<void> {
   const before = harness.actions.length;
   harness.dispatch(action);
   await waitFor(() => harness.actions.slice(before).some(sent => SetDirtyStateAction.is(sent) && sent.reason === reason), {
      message: `no '${reason}' dirty state`
   });
}

describe('__GRAMMAR__ diagram', () => {
   it('creates a node after the existing ones, keeping their comments, and undoes and redoes it', async () => {
      workspace = makeScratchWorkspace({ prefix: '__GRAMMAR_ID__-diagram-' });
      const original = '// keep this comment\nnode first -> second\n// about second\nnode second';
      const file = workspace.write('model.__EXTENSION__', original);
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<__GRAMMAR__GlspState>({
         serverModule: new ServerModule().configureDiagramModule(new __GRAMMAR__DiagramModule()),
         diagramType: __GRAMMAR_ID_CONST___DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);
      const uri = workspace.uri('model.__EXTENSION__');
      const text = (): string | undefined => shared.workspace.TextDocuments.get(uri)?.getText();

      await send(diagram, CreateNodeOperation.create(__GRAMMAR_ID_CONST___NODE_TYPE), 'operation');
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

   it('draws no edge for a reference that resolves into another document', async () => {
      workspace = makeScratchWorkspace({ prefix: '__GRAMMAR_ID__-diagram-' });
      workspace.write('declaring.__EXTENSION__', 'node second');
      const file = workspace.write('referencing.__EXTENSION__', 'node first -> second');
      const { shared } = createServices();
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      diagram = makeGlspHarness<__GRAMMAR__GlspState>({
         serverModule: new ServerModule().configureDiagramModule(new __GRAMMAR__DiagramModule()),
         diagramType: __GRAMMAR_ID_CONST___DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      await diagram.start();
      await diagram.openDocument(file);

      // The reference resolves, so the missing edge is the document rule and
      // not a dangling reference.
      expect(diagram.state.sourceRoot?.nodes[0].target?.ref?.name).toBe('second');
      expect(diagram.state.root.children.map(child => child.type)).toEqual([__GRAMMAR_ID_CONST___NODE_TYPE]);
   });

   it('resolves a cross-document reference in a document opened before the workspace is up', async () => {
      workspace = makeScratchWorkspace({ prefix: '__GRAMMAR_ID__-diagram-' });
      workspace.write('declaring.__EXTENSION__', 'node second');
      const file = workspace.write('referencing.__EXTENSION__', 'node first -> second');
      const { shared } = createServices();
      diagram = makeGlspHarness<__GRAMMAR__GlspState>({
         serverModule: new ServerModule().configureDiagramModule(new __GRAMMAR__DiagramModule()),
         diagramType: __GRAMMAR_ID_CONST___DIAGRAM_TYPE,
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
