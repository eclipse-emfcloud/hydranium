/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A diagram as one client session, through the real GLSP container and the real
 * store: the storage registers the GLSP client id, the diagram opens what it
 * works on through that session, writes its write set all or none, and ending
 * the GLSP session closes everything it had open.
 *
 * Asserted on the store's open table and on document text, because both
 * failure modes these guard are invisible on the canvas: an open nothing ever
 * closes, and one document of a set written while its sibling was refused.
 *
 * The workspace is a scratch copy: these tests write.
 */

import 'reflect-metadata';
import {
   ChangeBoundsOperation,
   CreateNodeOperation,
   DeleteElementOperation,
   MessageAction,
   RejectAction,
   RequestModelAction,
   SOURCE_URI_ARG,
   SaveModelAction,
   ServerModule
} from '@eclipse-glsp/server';
import { DIAGRAM_SESSION_REFUSED, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { ForceConflictResolver, asSnapshotVersion } from '@hydranium/protocol';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ServerSharedServices } from '@hydranium/core';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { waitFor } from '@hydranium/protocol/testing';
import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import { type ProcessModel } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';
const CLIENT_ID = 'process-diagram_0';

interface Diagram {
   readonly harness: GlspHarness<OrderFlowGlspState>;
   readonly shared: ServerSharedServices;
   readonly processUri: string;
   readonly layoutUri: string;
   readonly text: (uri: string) => string | undefined;
   readonly isOpenForDiagram: (uri: string) => boolean;
   readonly foreignWrite: (uri: string, text: string) => Promise<void>;
}

let harness: GlspHarness<OrderFlowGlspState> | undefined;
let scratch: ScratchWorkspace | undefined;

afterEach(() => {
   harness?.dispose();
   harness = undefined;
   scratch?.dispose();
   scratch = undefined;
});

/** Boot the real GLSP container over a scratch copy; `open` also opens `relativePath` in the diagram. */
async function startDiagram(relativePath: string, options: { open: boolean } = { open: true }): Promise<Diagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   const sourcePath = workspace.resolve(relativePath);
   const processUri = URI.file(sourcePath).toString();
   const layoutUri = processUri.replace(/\.process$/, '.layout');
   const started = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      clientSessionId: CLIENT_ID,
      additionalClientActionKinds: [MessageAction.KIND],
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   harness = started;
   const shared = services.shared;
   const diagram: Diagram = {
      harness: started,
      shared,
      processUri,
      layoutUri,
      text: uri => shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText(),
      isOpenForDiagram: uri => shared.workspace.TextDocuments.isOpenInClient(uri, CLIENT_ID),
      foreignWrite: async (uri, text) => {
         // A repeat open changes nothing, so every write can open first.
         const models = shared.model.ModelService;
         const editor = models.getSession('text-editor') ?? models.createSession('text-editor', 'text-editor');
         await editor.open(uri);
         await editor.update({ uri, model: text, basedOn: 'anything' });
      }
   };
   if (options.open) {
      await started.start();
      await started.openDocument(sourcePath);
      // The layout opens for the diagram as it joins the write set, which the
      // load does not wait for; a test asserting on the diagram's opens has to.
      if (diagram.text(layoutUri) !== undefined) {
         await waitFor(() => diagram.isOpenForDiagram(layoutUri), { message: 'the layout was never opened for the diagram' });
      }
   }
   return diagram;
}

/** The id the server emitted for a flow node, via the real index. */
function idOf(diagram: Diagram, name: string): string {
   const node = (diagram.harness.state.sourceRoot as ProcessModel).nodes.find(candidate => candidate.name === name);
   if (!node) {
      throw new Error(`no flow node named ${name}`);
   }
   return diagram.harness.state.index.createId(node);
}

/** Ask the diagram for its model, as a client opening it does. */
function requestModel(diagram: Diagram): void {
   diagram.harness.dispatch(RequestModelAction.create({ options: { [SOURCE_URI_ARG]: URI.parse(diagram.processUri).fsPath } }));
}

describe('order-flow .process diagram as a client session', () => {
   it('registers its GLSP client id as a session with the process and its layout open', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess);

      expect(diagram.shared.model.ModelService.getSession(CLIENT_ID)?.clientId).toBe(CLIENT_ID);
      expect(diagram.isOpenForDiagram(diagram.processUri)).toBe(true);
      // Open from joining the write set, before the diagram has written it
      // (the setup waits for it).
      expect(diagram.isOpenForDiagram(diagram.layoutUri)).toBe(true);
   });

   it('closes everything the diagram had open, the layout it wrote included, when its GLSP session ends', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess);
      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 300, y: 220 }, newSize: { width: 200, height: 80 } }
         ])
      );
      await waitFor(() => diagram.text(diagram.layoutUri)?.includes('node Pay at 300, 220') ?? false, { message: 'the drag never landed' });
      expect(diagram.isOpenForDiagram(diagram.layoutUri)).toBe(true);

      await diagram.harness.shutdown();

      expect(diagram.shared.model.ModelService.getSession(CLIENT_ID)).toBeUndefined();
      expect(diagram.isOpenForDiagram(diagram.processUri)).toBe(false);
      expect(diagram.isOpenForDiagram(diagram.layoutUri)).toBe(false);
   });

   it('refuses a diagram whose client id another participant still holds, tells the user, and opens nothing under it', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess, { open: false });
      const holder = diagram.shared.model.ModelService.createSession('holder', CLIENT_ID);
      await diagram.harness.start();

      requestModel(diagram);

      // After the bounded wait for the id to free. A model request is a
      // REQUEST, so its rejection carries only the developer-facing cause; the
      // user reads the message dispatched beside it.
      const rejection = await diagram.harness.nextAction<RejectAction>(RejectAction.KIND, 5_000);
      expect(rejection.detail).toContain(CLIENT_ID);
      const message = await diagram.harness.nextAction<MessageAction>(MessageAction.KIND);
      expect(message.message).toBe(DIAGRAM_SESSION_REFUSED.text);
      expect(diagram.isOpenForDiagram(diagram.processUri)).toBe(false);
      // The holder's session is left alone.
      expect(diagram.shared.model.ModelService.getSession(CLIENT_ID)).toBe(holder);
   });

   it('loads a diagram whose client id was held when its GLSP session started and has freed since', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess, { open: false });
      const holder = diagram.shared.model.ModelService.createSession('holder', CLIENT_ID);
      await diagram.harness.start();
      holder.dispose();

      requestModel(diagram);

      await diagram.harness.nextModelSubmission();
      expect(diagram.isOpenForDiagram(diagram.processUri)).toBe(true);
      expect(diagram.harness.state.modelSession?.clientId).toBe(CLIENT_ID);
   });

   it('loads a diagram whose client id frees while the load waits for it', async () => {
      // A reloaded client reconnecting before the server has noticed its old
      // connection close, which ends that connection's sessions a moment later.
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess, { open: false });
      const holder = diagram.shared.model.ModelService.createSession('holder', CLIENT_ID);
      await diagram.harness.start();

      requestModel(diagram);
      await new Promise(resolve => setTimeout(resolve, 200));
      holder.dispose();

      // Well inside the two-second wait: the holder's end wakes the load, not
      // the wait running out.
      await diagram.harness.nextModelSubmission({ timeoutMs: 1_000 });
      expect(diagram.isOpenForDiagram(diagram.processUri)).toBe(true);
   });

   it('does not overwrite another client’s edit to the layout entry a drag moves', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess);
      const layoutBefore = diagram.text(diagram.layoutUri)!;
      expect(layoutBefore).toContain('node Pay at 40, 100 size 160, 60');
      const capturedLayoutVersion = diagram.harness.state.snapshotVersionOf(diagram.layoutUri);

      await diagram.foreignWrite(diagram.layoutUri, layoutBefore.replace('node Pay at 40, 100', 'node Pay at 41, 101'));
      // The gate is armed: the diagram still holds the layout version it read.
      expect(diagram.harness.state.snapshotVersionOf(diagram.layoutUri)).toBe(capturedLayoutVersion);

      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 300, y: 220 }, newSize: { width: 160, height: 60 } }
         ])
      );
      await diagram.harness.nextModelSubmission({ timeoutMs: 500, rejectOnTimeout: false });

      // The same field changed underneath, so the drag is dropped rather than
      // written over the other client's position.
      expect(diagram.text(diagram.layoutUri)).toContain('node Pay at 41, 101');
      expect(diagram.text(diagram.layoutUri)).not.toContain('node Pay at 300, 220');
   });

   it('gates a drag on the store version of a layout an editor opened before its rebuild', async () => {
      // An editor's first open gives the layout the editor's version, while
      // the built document keeps its own until a rebuild. Nothing in this
      // harness rebuilds on an editor open, so the window stays open.
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess, { open: false });
      await diagram.harness.start();
      const languageId = diagram.shared.ServiceRegistry.getServices(URI.parse(diagram.layoutUri)).LanguageMetaData.languageId;
      diagram.shared.workspace.TextDocuments.notifyDidOpenTextDocument({
         textDocument: { uri: diagram.layoutUri, languageId, version: 5, text: diagram.text(diagram.layoutUri)! }
      });
      expect(diagram.shared.workspace.TextDocuments.version(diagram.layoutUri)).toBe(5);
      await diagram.harness.openDocument(URI.parse(diagram.processUri).fsPath);
      await waitFor(() => diagram.isOpenForDiagram(diagram.layoutUri), { message: 'the layout was never opened for the diagram' });
      expect(diagram.shared.model.ModelService.getDocument(diagram.layoutUri)?.textDocument.version).toBe(0);
      // A write gated on the built version conflicts with nobody writing.
      const refetch = vi.spyOn(diagram.harness.state as unknown as { refetch(): Promise<unknown> }, 'refetch');

      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 300, y: 220 }, newSize: { width: 160, height: 60 } }
         ])
      );
      await waitFor(() => diagram.text(diagram.layoutUri)?.includes('node Pay at 300, 220') ?? false, {
         message: 'the drag never landed'
      });

      expect(refetch).not.toHaveBeenCalled();
   });

   it('lands a new layout entry once when its write conflicts with nobody else writing', async () => {
      // The drag adds the entry to the parsed layout before the write, so a
      // reconcile against that root would add it twice.
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess);
      expect(diagram.text(diagram.layoutUri)).not.toContain('node Cancel');
      // A layout gate that fails over unchanged text.
      Object.defineProperty(diagram.harness.state, 'secondaryBasedOn', { value: () => asSnapshotVersion(99) });

      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Cancel'), newPosition: { x: 20, y: 300 }, newSize: { width: 160, height: 60 } }
         ])
      );
      await waitFor(() => diagram.text(diagram.layoutUri)?.includes('node Cancel at 20, 300') ?? false, {
         message: 'the drag never landed'
      });

      expect(diagram.text(diagram.layoutUri)!.match(/node Cancel /g)).toHaveLength(1);
   });

   it('writes the process and the layout all or none', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.fulfillmentProcess);
      const layoutBefore = diagram.text(diagram.layoutUri)!;
      expect(diagram.text(diagram.processUri)).toContain('task Pick');
      expect(layoutBefore).toContain('node Pick at 440, 200');

      // Another client moves the entry the delete is about to remove, so the
      // layout half of the delete collides while its process half would not.
      await diagram.foreignWrite(diagram.layoutUri, layoutBefore.replace('node Pick at 440, 200', 'node Pick at 450, 210'));

      diagram.harness.dispatch(DeleteElementOperation.create([idOf(diagram, 'Pick')]));
      await diagram.harness.nextModelSubmission({ timeoutMs: 500, rejectOnTimeout: false });

      // Neither document took the delete: the process keeps the node whose
      // layout entry could not be removed.
      expect(diagram.text(diagram.processUri)).toContain('task Pick');
      expect(diagram.text(diagram.layoutUri)).toContain('node Pick at 450, 210');
   });

   it('creates the layout of a process that has none through the session, and keeps it open', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.returnsProcess);
      expect(diagram.text(diagram.layoutUri)).toBeUndefined();

      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Receive'), newPosition: { x: 20, y: 20 }, newSize: { width: 140, height: 50 } }
         ])
      );
      await waitFor(() => diagram.text(diagram.layoutUri)?.includes('node Receive at 20, 20 size 140, 50') ?? false, {
         message: 'the drag never landed'
      });

      expect(diagram.text(diagram.layoutUri)).toContain('layout ReturnsLayout for Returns');
      expect(diagram.isOpenForDiagram(diagram.layoutUri)).toBe(true);
   });

   it('closes the layout it created when the write set it was created for is dropped, so no save writes it', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.returnsProcess);
      const layoutPath = URI.parse(diagram.layoutUri).fsPath;
      // Every conflict drops the edit.
      Object.defineProperty(diagram.harness.state, 'conflictResolver', {
         value: { resolve: async () => ({ status: 'conflict', theirs: undefined }) }
      });
      await diagram.foreignWrite(diagram.processUri, diagram.text(diagram.processUri)!.replace('task Receive', 'task Receive2'));

      diagram.harness.dispatch(CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } }));
      await diagram.harness.nextModelSubmission({ timeoutMs: 1_000, rejectOnTimeout: false });

      expect(diagram.text(diagram.processUri)).not.toContain('NewTask');
      expect(diagram.isOpenForDiagram(diagram.layoutUri)).toBe(false);
      const saved: string[] = [];
      diagram.shared.workspace.TextDocuments.onDidSave(event => saved.push(event.document.uri));
      diagram.harness.dispatch(SaveModelAction.create());
      await waitFor(() => saved.length > 0, { message: 'the save never ran' });
      // An absence: give a layout write the time the process write took.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(existsSync(layoutPath)).toBe(false);
   });

   it('creates the layout again for the forced retry of a write set whose first attempt conflicted', async () => {
      // The first attempt's layout was closed with it, so the retry finds no
      // layout and creates it afresh.
      const diagram = await startDiagram(WORKSPACE_FILES.returnsProcess);
      Object.defineProperty(diagram.harness.state, 'conflictResolver', { value: new ForceConflictResolver() });
      await diagram.foreignWrite(diagram.processUri, diagram.text(diagram.processUri)!.replace('task Receive', 'task Receive2'));

      diagram.harness.dispatch(CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } }));
      await waitFor(() => diagram.text(diagram.layoutUri)?.includes('node NewTask at 320, 480') ?? false, {
         message: 'the merged create never reached the layout'
      });
      expect(diagram.text(diagram.processUri)).toContain('NewTask');
      expect(diagram.isOpenForDiagram(diagram.layoutUri)).toBe(true);
   });

   it('opens a layout file the workspace has not read instead of failing to create it', async () => {
      const diagram = await startDiagram(WORKSPACE_FILES.returnsProcess);
      const layoutPath = URI.parse(diagram.layoutUri).fsPath;
      writeFileSync(layoutPath, 'layout ReturnsLayout for Returns {\n}\n');
      expect(diagram.text(diagram.layoutUri)).toBeUndefined();

      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Receive'), newPosition: { x: 20, y: 20 }, newSize: { width: 140, height: 50 } }
         ])
      );

      await waitFor(() => diagram.text(diagram.layoutUri)?.includes('node Receive at 20, 20') ?? false, {
         message: 'the drag never landed'
      });
      expect(readFileSync(layoutPath, 'utf8')).toContain('layout ReturnsLayout for Returns');
   });

   it('fails a write whose layout cannot be serialised, rather than opening a layout that does not exist', async () => {
      // Only a failed create means the layout may exist and should be opened;
      // an open of a missing layout fails with a file error that hides this one.
      const diagram = await startDiagram(WORKSPACE_FILES.returnsProcess);
      const serializer = diagram.shared.ServiceRegistry.getServices(URI.parse(diagram.layoutUri)).serializer.Serializer;
      vi.spyOn(serializer, 'serializeTransfer').mockImplementation(() => {
         throw new Error('the layout serializer broke');
      });

      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Receive'), newPosition: { x: 20, y: 20 }, newSize: { width: 140, height: 50 } }
         ])
      );

      const message = await diagram.harness.nextAction<MessageAction>(MessageAction.KIND);
      // An operation is no request: the failure's text travels in `details`.
      expect(message.details).toContain('the layout serializer broke');
      expect(diagram.text(diagram.layoutUri)).toBeUndefined();
   });
});
