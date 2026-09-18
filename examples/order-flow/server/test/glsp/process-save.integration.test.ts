/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `SaveModelAction` against the real DI container, asserted on DISK.
 *
 * Every other diagram suite stops at the AST and the in-memory text, which is
 * where a save's two failure modes hide: a write set that reaches the store but
 * not the filesystem, and a document persisted by re-serializing an AST that
 * nothing changed. Neither is observable without reading the files back.
 *
 * A pure bounds drag is the sharpest case. It changes the `.layout` secondary
 * and nothing else, so a correct save writes that file and leaves the `.process`
 * primary byte-identical — comments, wrapping and trailing newline included,
 * none of which survive a serializer round-trip.
 */

import 'reflect-metadata';
import { ChangeBoundsOperation, SaveModelAction, ServerModule } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { type ProcessModel } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

let harness: GlspHarness<OrderFlowGlspState> | undefined;
let scratch: ScratchWorkspace | undefined;
/** Saves the store announced, in order — the signal that a file was written at all. */
let savedUris: string[] = [];

afterEach(() => {
   harness?.dispose();
   harness = undefined;
   scratch?.dispose();
   scratch = undefined;
});

/** Boot the real GLSP container over a scratch copy and open the `.process` file. */
async function openDiagram(): Promise<GlspHarness<OrderFlowGlspState>> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   savedUris = [];
   services.shared.workspace.TextDocuments.onDidSave(event => savedUris.push(event.document.uri));
   const opened = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   harness = opened;
   await opened.start();
   await opened.openDocument(workspace.resolve(WORKSPACE_FILES.fulfillmentProcess));
   return opened;
}

/** The id the server emitted for a flow node, via the real index. */
function idOf(diagram: GlspHarness<OrderFlowGlspState>, name: string): string {
   const node = (diagram.state.sourceRoot as ProcessModel).nodes.find(candidate => candidate.name === name);
   if (!node) {
      throw new Error(`no flow node named ${name}`);
   }
   return diagram.state.index.createId(node);
}

/**
 * Wait until the file at `path` contains `needle`.
 *
 * The save's own completion signal cannot be used: its handler dispatches a
 * dirty-state action, and so does the bounds operation that has to precede it,
 * so a wait keyed on that action resolves on the operation's under load and
 * asserts against a save that has not run. The write this test is about is the
 * only unambiguous evidence the save finished.
 *
 * Sound as a barrier for BOTH documents, because the flush writes the primary
 * before the secondary: by the time the layout lands, the process file's write
 * has already happened or already been skipped.
 */
async function waitForFileToContain(path: string, needle: string): Promise<void> {
   for (let attempt = 0; attempt < 200; attempt++) {
      if (readFileSync(path, 'utf8').includes(needle)) {
         return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
   }
   throw new Error(`${path} never came to contain ${needle}`);
}

describe('order-flow .process save', () => {
   it('writes the moved bounds to disk and leaves the process file untouched', async () => {
      const diagram = await openDiagram();
      const processPath = scratch!.resolve(WORKSPACE_FILES.fulfillmentProcess);
      const layoutPath = scratch!.resolve(WORKSPACE_FILES.fulfillmentDiagram);
      const processOnDisk = readFileSync(processPath, 'utf8');
      // Control inside the test: the entry starts where the sample workspace put
      // it, so neither assertion below can pass by the value never changing.
      expect(readFileSync(layoutPath, 'utf8')).toContain('node Pay at 40, 100');

      diagram.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 300, y: 220 }, newSize: { width: 200, height: 80 } }
         ])
      );
      await diagram.nextModelSubmission();

      diagram.dispatch(SaveModelAction.create());
      // The document the drag changed reaches the filesystem.
      await waitForFileToContain(layoutPath, 'node Pay at 300, 220 size 200, 80');
      // The document it did not change is not rewritten. Byte equality, because
      // the losses are formatting: the leading comment, the wrapped `task` lines
      // and the trailing newline all survive only an untouched file.
      expect(readFileSync(processPath, 'utf8')).toBe(processOnDisk);
   });

   it('leaves a document whose content already matches disk unwritten, and announces it anyway', async () => {
      // Byte equality cannot tell "not written" from "rewritten identically",
      // and the difference is an mtime — enough to prompt an editor to reload
      // and to make an mtime-keyed build treat the file as work. The save
      // announcement cannot separate them either: a save announces that the
      // content is on disk, which holds for a document that was already there.
      // So the mtime is the observable, and the layout's is what separates a
      // skipped write from a save that never ran at all.
      const diagram = await openDiagram();
      const processPath = scratch!.resolve(WORKSPACE_FILES.fulfillmentProcess);
      const layoutPath = scratch!.resolve(WORKSPACE_FILES.fulfillmentDiagram);
      const processMtime = statSync(processPath).mtimeMs;
      const layoutMtime = statSync(layoutPath).mtimeMs;

      diagram.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 300, y: 220 }, newSize: { width: 200, height: 80 } }
         ])
      );
      await diagram.nextModelSubmission();

      diagram.dispatch(SaveModelAction.create());
      await waitForFileToContain(layoutPath, 'node Pay at 300, 220 size 200, 80');

      expect(statSync(processPath).mtimeMs).toBe(processMtime);
      expect(statSync(layoutPath).mtimeMs).not.toBe(layoutMtime);
      // Every document in the write set announces, written or not: a consumer
      // that clears a dirty marker on save must not have to know which.
      expect(savedUris).toEqual([diagram.state.sourceUri, diagram.state.layoutUri]);
   });
});
