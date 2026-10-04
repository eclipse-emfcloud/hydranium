/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The starter create-node handler, run the way a client runs it: an in-process
// GLSP server opens a document, a create-node operation adds a node, and an undo
// and a redo take it out and put it back. Every step must keep the nodes the
// document already had, and its comments: the diagram writes the document from
// its AST, which carries none.

import 'reflect-metadata';
import { type Action, CreateNodeOperation, RedoAction, ServerModule, SetDirtyStateAction, UndoAction } from '@eclipse-glsp/server';
import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { BookstoreDiagramModule } from '../src/glsp/bookstore/diagram-module.js';
import type { BookstoreGlspState } from '../src/glsp/bookstore/state.js';
import { BOOKSTORE_DIAGRAM_TYPE, BOOKSTORE_NODE_TYPE } from '../src/glsp/bookstore/types.js';
import { createServices } from '../src/services.js';

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
});
