/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// GLSP's own saveable against the order-flow diagram on the real text store.
// It sends a `SaveModelAction` and settles on the first dirty-state change the
// client's editor context reports with reason 'save'. That context keeps a
// dirty state only when it changes, so a clean state that reaches it first
// under another reason leaves the save's own answer changing nothing, and the
// save times out although the file was written. Only the real client context
// and the real store's flips inside the save show that.
vi.hoisted(() => {
   // GLSP's client `require`s its stylesheets; Node would parse them as code.
   const { createRequire } = globalThis.process.getBuiltinModule('node:module');
   createRequire(__filename).extensions['.css'] = module => {
      module.exports = {};
   };
});

import 'reflect-metadata';
import {
   type Action,
   ActionHandlerRegistry,
   DefaultModelInitializationConstraint,
   EditorContextService,
   GLSPActionDispatcher,
   NullLogger,
   SetDirtyStateAction
} from '@eclipse-glsp/client';
import { GLSPSaveable } from '@eclipse-glsp/theia-integration/lib/browser/diagram/glsp-saveable';
import { ChangeBoundsOperation, DefaultGLSPServer, ServerModule } from '@eclipse-glsp/server';
import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/lib/node';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/lib/testing/node';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/lib/testing';
import { OrderFlowProcessDiagramModule } from '@hydranium/example-order-flow-server/lib/glsp/order-flow-process-diagram-module.js';
import type { OrderFlowGlspState } from '@hydranium/example-order-flow-server/lib/glsp/order-flow-glsp-state.js';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module.js';
import type { ProcessModel } from '@hydranium/example-order-flow-server/lib/language-server/ast.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DIAGRAM_TYPE = 'order-flow-process';
const WORKSPACE_ROOT = path.resolve(__dirname, '../../workspace');
const LAYOUT_FILE = 'orders/fulfillment.layout';

/**
 * GLSP's client dispatcher with the wiring a diagram container gives it: the
 * editor context takes dirty-state changes, and the kinds the server handles
 * go to the server, as GLSP's model source forwards them.
 */
class WiredDispatcher extends GLSPActionDispatcher {
   constructor(context: EditorContextService, serverKinds: readonly string[], toServer: (action: Action) => void) {
      super();
      const registry = new ActionHandlerRegistry([], []);
      registry.register(SetDirtyStateAction.KIND, context);
      for (const kind of serverKinds) {
         registry.register(kind, { handle: action => void toServer(action) });
      }
      this.actionHandlerRegistry = registry;
      this.initializationConstraint = new DefaultModelInitializationConstraint();
      this.diagramLocker = { isAllowed: () => true };
      this.logger = new NullLogger();
      this.initialized = Promise.resolve();
   }
}

let diagram: GlspHarness<OrderFlowGlspState> | undefined;
let scratch: ScratchWorkspace | undefined;
let pump: ReturnType<typeof setInterval> | undefined;

afterEach(() => {
   clearInterval(pump);
   diagram?.dispose();
   diagram = undefined;
   scratch?.dispose();
   scratch = undefined;
});

describe('GLSP’s saveable on the order-flow diagram', () => {
   it('settles a save of a drag on the save’s own dirty state', async () => {
      scratch = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-diagram-save-' });
      const { shared } = createOrderFlowServices({ ...NodeFileSystem }, {});
      await initializeWorkspaceProgrammatically(shared, scratch.root);
      const server = makeGlspHarness<OrderFlowGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
         diagramType: DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      diagram = server;
      await server.start();
      await server.openDocument(scratch.resolve('orders/fulfillment.process'));

      const context = new EditorContextService();
      const initialized = await server.server.initialize({
         applicationId: 'test-app',
         protocolVersion: DefaultGLSPServer.PROTOCOL_VERSION
      });
      const dispatcher = new WiredDispatcher(context, initialized.serverActions[DIAGRAM_TYPE], action => void server.dispatch(action));
      // The server's actions reach the client in the order it sent them, as
      // over a socket.
      let delivered = 0;
      pump = setInterval(() => {
         while (delivered < server.actions.length) {
            void dispatcher.dispatch(server.actions[delivered++]).catch(() => undefined);
         }
      }, 1);
      const saveable = new GLSPSaveable(dispatcher, context);

      const root = server.state.sourceRoot as ProcessModel;
      const pay = root.nodes.find(node => node.name === 'Pay')!;
      server.dispatch(
         ChangeBoundsOperation.create([
            { elementId: server.state.index.createId(pay), newPosition: { x: 300, y: 220 }, newSize: { width: 200, height: 80 } }
         ])
      );
      await vi.waitFor(() => expect(context.isDirty).toBe(true), { timeout: 10_000 });

      await expect(saveable.save()).resolves.toBeUndefined();
      expect(context.isDirty).toBe(false);
      expect(readFileSync(scratch.resolve(LAYOUT_FILE), 'utf8')).toContain('300');
   });
});
