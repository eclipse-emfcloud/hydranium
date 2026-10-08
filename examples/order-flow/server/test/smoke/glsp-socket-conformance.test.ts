/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `@hydranium/conformance/glsp` slice run against the shipped `lib/main.js`
 * over its GLSP socket, so the write path is proven across the transport a host
 * uses, not only in-process.
 *
 * The write is observed where a host sees it: as the `workspace/applyEdit` the
 * server pushes on the LSP channel. The server pushes only for a document the
 * language client has open, so `beforeAll` opens the `.process` there first;
 * without that the edit stays in the server's store and nothing here could see it.
 *
 * Each session answers `requestBounds` with `computedBounds`, the client's half
 * of a layout, so a load completes with `setModel` as it does for a host.
 *
 * Every check opens its own socket and session on one spawned server, so the
 * create check's unsaved edit stays in that server's store. It is the fixture's
 * last check, which is what keeps it from reaching another.
 */

import {
   type Action,
   ComputedBoundsAction,
   CreateNodeOperation,
   type GNode,
   RequestBoundsAction,
   RequestModelAction,
   SelectAction,
   SetModelAction,
   SOURCE_URI_ARG,
   UpdateModelAction
} from '@eclipse-glsp/server';
import { connectGlspSocketDriver, type GlspSocketDriver } from '@hydranium/conformance/glsp/node';
import { runGlspConformance, type GlspFixture } from '@hydranium/conformance/vitest';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { isRejectionOrError, MINIMAL_CLIENT_ACTION_KINDS } from '@hydranium/glsp-server/testing';
import { tick } from '@hydranium/protocol/testing';
import { readFileSync } from 'node:fs';
import { DidOpenTextDocumentNotification } from 'vscode-languageserver-protocol/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_GATEWAY_NODE_TYPE, PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import { ProcessLanguageMetaData } from '../../src/language-server/generated/module.js';
import { ORDER_FLOW_GLSP_PORT_COMMAND } from '../../src/head-ports.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from '../order-flow-harness.js';
import { SPAWN_TIMEOUT_MS, type SpawnedOrderFlowServer, startSpawnedOrderFlowServer } from './spawned-order-flow-server.js';

const DIAGRAM_TYPE = 'order-flow-process';

/** GLSP ships no constant for it; order-flow's create handler sends the literal. */
const EDIT_LABEL_KIND = 'EditLabel';

/** `fulfillment.process`: tasks Pay / Pick / Ship / Cancel plus gateway PaymentOk. */
const FULFILLMENT_NODE_COUNT = 5;

/** The socket driver, plus the spawned server whose LSP channel carries the write. */
type Driver = GlspSocketDriver<Action> & { readonly server: SpawnedOrderFlowServer };

let server: SpawnedOrderFlowServer | undefined;
let workspace: ScratchWorkspace | undefined;
let glspPort: number | undefined;

beforeAll(async () => {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-smoke-glsp-conformance-' });
   server = await startSpawnedOrderFlowServer({ workspaceRoot: workspace.root });
   glspPort = await server.port(ORDER_FLOW_GLSP_PORT_COMMAND);
   const uri = workspace.uri(WORKSPACE_FILES.fulfillmentProcess);
   // Awaited through its diagnostics, so the open is in the server's store
   // before any check writes the document over the other channel.
   const from = server.diagnostics.length;
   // A failed send shows as the diagnostics wait below timing out.
   server.connection
      .sendNotification(DidOpenTextDocumentNotification.type, {
         textDocument: {
            uri,
            languageId: ProcessLanguageMetaData.languageId,
            version: 1,
            text: readFileSync(workspace.resolve(WORKSPACE_FILES.fulfillmentProcess), 'utf8')
         }
      })
      .catch(() => undefined);
   await server.nextDiagnostics(uri, { fromIndex: from });
}, SPAWN_TIMEOUT_MS);

afterAll(async () => {
   await server?.dispose();
   server = undefined;
   workspace?.dispose();
   workspace = undefined;
}, SPAWN_TIMEOUT_MS);

function ready(): { readonly server: SpawnedOrderFlowServer; readonly workspace: ScratchWorkspace; readonly port: number } {
   if (!server || !workspace || glspPort === undefined) {
      throw new Error('spawned server not started');
   }
   return { server, workspace, port: glspPort };
}

async function connect(): Promise<Driver> {
   const { server: spawned, port } = ready();
   const driver = await connectGlspSocketDriver<Action>({
      port,
      diagramType: DIAGRAM_TYPE,
      // order-flow's create follows its update with these two; a host
      // declares them.
      clientActionKinds: [...MINIMAL_CLIENT_ACTION_KINDS, EDIT_LABEL_KIND, SelectAction.KIND],
      // Measured nothing, which the server accepts as is.
      respond: action =>
         RequestBoundsAction.is(action) ? ComputedBoundsAction.create([], { revision: action.newRoot.revision }) : undefined
   });
   return { ...driver, server: spawned };
}

function flowNodes(response: Action): GNode[] {
   const children = SetModelAction.is(response) ? (response.newRoot.children ?? []) : [];
   return children.filter((child): child is GNode => child.type === PROCESS_TASK_NODE_TYPE || child.type === PROCESS_GATEWAY_NODE_TYPE);
}

/** Recorded when the operation is built, so the wait below reads only pushes the operation caused. */
let editsBeforeOperation = 0;

const fulfillmentFixture: GlspFixture<Action, Driver> = {
   diagramType: `${DIAGRAM_TYPE} over a socket (fulfillment)`,
   prepare: () => undefined,
   requestModel: () =>
      RequestModelAction.create({ options: { [SOURCE_URI_ARG]: ready().workspace.resolve(WORKSPACE_FILES.fulfillmentProcess) } }),
   expectedResponseKind: SetModelAction.KIND,
   expectResponse: response => flowNodes(response).length === FULFILLMENT_NODE_COUNT,
   createOperation: {
      action: driver => {
         editsBeforeOperation = driver.server.appliedEdits.length;
         return CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE);
      },
      expectedResponseKind: UpdateModelAction.KIND,
      expectMutated: async driver => {
         const uri = ready().workspace.uri(WORKSPACE_FILES.fulfillmentProcess);
         // A rejected request still lets the write complete, so check for it.
         // Thrown, so the failure names the error; checked on the timeout path
         // too, where a rejection may be the cause.
         const throwOnReportedErrors = (): void => {
            const errors = driver.actions.filter(isRejectionOrError);
            if (errors.length > 0) {
               throw new Error(`The server reported errors to this session: ${JSON.stringify(errors)}`);
            }
         };
         try {
            // Rejects, naming the URI, when no push carries the new task.
            await driver.server.nextAppliedEdit(uri, {
               fromIndex: editsBeforeOperation,
               match: edit => /\btask NewTask\b/.test(edit.text)
            });
            // The last action the create sends, so an error raised after the
            // update has arrived before the check below.
            await driver.nextAction(SelectAction.KIND);
         } catch (error: unknown) {
            throwOnReportedErrors();
            throw error;
         }
         throwOnReportedErrors();
         return true;
      }
   }
};

runGlspConformance<Action, Driver>({
   suiteTitle: 'conformance: glsp over a socket (order-flow lib/main.js)',
   connect,
   diagrams: [fulfillmentFixture]
});

describe('the spawned server after every check', () => {
   it('logged no unhandled rejection', async () => {
      // Each check closes its socket while the session may still have work
      // scheduled, such as live validation, which runs after the last response.
      // An absence, so it waits past that work first.
      await tick(500);
      expect(
         ready()
            .server.logMessages.map(entry => entry.message)
            .filter(message => message.includes('Unhandled promise rejection'))
      ).toEqual([]);
   });
});
