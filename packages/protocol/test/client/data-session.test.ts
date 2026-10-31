/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A session over a server that WIDENS the document arguments.
 *
 * The assertions read the payload the SERVER received, because a wrapper that
 * rebuilt the arguments field by field would type-check and still drop the
 * widened one on the wire. What the wrappers refuse is a separate, type-level
 * question, asserted in the sibling `*.types.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import { DataConnection } from '../../src/client/data-connection';
import { DataEvents } from '../../src/client/data-events';
import { DataSession } from '../../src/client/data-session';
import { DATA_SERVER_WIRE_PREFIX, type DataServerProtocol, type DiagnosticOf, type TransferSaveDocumentArgs } from '../../src/data';
import type { CloseModelArgs, OpenModelArgs } from '../../src/model-server';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { makeFakeDataPort } from '../../src/testing/data-doubles';
import { makeDuplexConnectionPair } from '../../src/testing/node';
import type { TransferDocument, TransferSavedDocument } from '../../src/transfer-document';
import type { TransferElement } from '../../src/transfer-element';
import { captureUnhandledRejections } from '../../src/testing/node/unhandled-rejections';
import { tick, waitFor } from '../../src/testing/wait-for';

interface ProbeElement extends TransferElement {
   $type: 'TypeOne';
}

/** An adopter's open, carrying a field the framework's `OpenModelArgs` has no room for. */
interface WidenedOpenArgs extends OpenModelArgs {
   extra?: string;
}

/** The same widening on the save path. */
interface WidenedSaveArgs extends TransferSaveDocumentArgs<ProbeElement> {
   extra?: string;
}

/** The same widening on the close path. */
interface WidenedCloseArgs extends CloseModelArgs {
   extra?: string;
}

interface WidenedServer extends DataServerProtocol<ProbeElement> {
   openModelDocument(args: WidenedOpenArgs): Promise<TransferDocument<ProbeElement>>;
   closeModelDocument(args: WidenedCloseArgs): Promise<void>;
   saveModelDocument(args: WidenedSaveArgs): Promise<TransferSavedDocument<ProbeElement>>;
}

const URI_A = 'file:///a.x';

function document(uri: string): unknown {
   return { uri, version: 1, root: { $type: 'TypeOne' }, diagnostics: [], persisted: { version: 1 } };
}

/** Bind a server that keeps every argument object verbatim, keyed by method. */
function echoingServer(connection: MessageConnection): Record<string, unknown[]> {
   const received: Record<string, unknown[]> = {};
   const record = (method: string) => async (args: { uri: string }) => {
      (received[method] ??= []).push(args);
      return document(args.uri);
   };
   const target = {
      waitForReady: async (): Promise<void> => undefined,
      createSession: async (): Promise<void> => undefined,
      closeSession: async (): Promise<void> => undefined,
      openModelDocument: record('open'),
      watchModelDocument: record('watch'),
      closeModelDocument: record('close'),
      updateModelDocument: record('update'),
      saveModelDocument: record('save')
   };
   bindRpcMethods(
      connection,
      target,
      [
         'waitForReady',
         'createSession',
         'closeSession',
         'openModelDocument',
         'watchModelDocument',
         'closeModelDocument',
         'updateModelDocument',
         'saveModelDocument'
      ],
      { methodNamespace: DATA_SERVER_WIRE_PREFIX }
   );
   return received;
}

function harness<TServer extends DataServerProtocol<ProbeElement, DiagnosticOf<TServer>>>(): {
   connection: DataConnection<ProbeElement, TServer>;
   received: Record<string, unknown[]>;
   dispose(): void;
} {
   const pair = makeDuplexConnectionPair();
   const received = echoingServer(pair.left);
   const port = makeFakeDataPort({ connect: () => pair.right });
   const connection = new DataConnection<ProbeElement, TServer>(port, new DataEvents<ProbeElement>());
   return {
      connection,
      received,
      dispose: () => {
         connection.dispose();
         pair.dispose();
      }
   };
}

describe('DataSession over a widened server', () => {
   it('carries an adopter save field through to the wire', async () => {
      const { connection, received, dispose } = harness<WidenedServer>();
      try {
         const panel = connection.createSession('panel', 'panel');

         await panel.saveDocument({ uri: URI_A, model: { $type: 'TypeOne' }, extra: 'save-field', baseVersion: 'any' });

         expect(received.save).toEqual([
            { uri: URI_A, clientId: 'panel', model: { $type: 'TypeOne' }, extra: 'save-field', baseVersion: 'any' }
         ]);
      } finally {
         dispose();
      }
   });

   it('carries an adopter close field through to the wire', async () => {
      const { connection, received, dispose } = harness<WidenedServer>();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });

         await panel.closeDocument({ uri: URI_A, extra: 'close-field' });

         expect(received.close).toEqual([{ uri: URI_A, clientId: 'panel', extra: 'close-field' }]);
      } finally {
         dispose();
      }
   });

   it('stamps its own clientId on a write carrying an adopter field', async () => {
      const { connection, received, dispose } = harness<WidenedServer>();
      try {
         const panel = connection.createSession('panel', 'panel');

         await panel.updateDocument({ uri: URI_A, model: { $type: 'TypeOne' }, baseVersion: 'any' });

         expect(received.update).toEqual([{ uri: URI_A, clientId: 'panel', model: { $type: 'TypeOne' }, baseVersion: 'any' }]);
      } finally {
         dispose();
      }
   });
});

/** Run `callback` and resolve to the rejections no one handled meanwhile. */
function unhandledDuring(callback: () => Promise<void>): Promise<unknown[]> {
   return captureUnhandledRejections(async rejections => {
      await callback();
      await waitFor(() => rejections.length > 0);
      await tick();
      return rejections;
   });
}

/** A session whose subclass reaches `trackEnding` and `trackOpen` directly. */
class EndingSession extends DataSession<ProbeElement, DataServerProtocol<ProbeElement>> {
   dropEnding(uri: string, end: () => Promise<void>): void {
      void this.trackEnding(uri, end);
   }

   end(uri: string, end: () => Promise<void>): Promise<void> {
      return this.trackEnding(uri, end);
   }

   open(uri: string, call: () => Promise<void>): Promise<void> {
      return this.trackOpen(uri, undefined, call);
   }
}

describe('DataSession tracking work a caller drops', () => {
   it('reports a failed write of several documents once', async () => {
      const { connection, dispose } = harness<DataServerProtocol<ProbeElement>>();
      try {
         const panel = connection.createSession('panel', 'panel');
         const unhandled = await unhandledDuring(async () => {
            // The echoing server binds no updateModelDocuments, so the write fails.
            void panel.updateDocuments({
               updates: [
                  { uri: URI_A, model: { $type: 'TypeOne' }, baseVersion: 'any' },
                  { uri: 'file:///b.x', model: { $type: 'TypeOne' }, baseVersion: 'any' }
               ]
            });
            await panel.whenWritesSettled();
         });

         expect(unhandled).toHaveLength(1);
      } finally {
         dispose();
      }
   });

   it('reports a failed close or delete once', async () => {
      const session = new EndingSession('panel', { connected: () => new Promise(() => undefined) }, 'panel');
      const failure = new Error('close failed');

      const unhandled = await unhandledDuring(async () => {
         session.dropEnding(URI_A, async () => {
            throw failure;
         });
      });

      expect(unhandled).toEqual([failure]);
   });

   it('resumes the caller of a close before an open waiting on it starts', async () => {
      const session = new EndingSession('panel', { connected: () => new Promise(() => undefined) }, 'panel');
      const order: string[] = [];

      const closing = (async () => {
         await session.end(URI_A, async () => {
            order.push('closed');
         });
         order.push('close caller resumed');
      })();
      await session.open(URI_A, async () => {
         order.push('opened');
      });
      await closing;

      expect(order).toEqual(['closed', 'close caller resumed', 'opened']);
   });

   it('reports a failed open once', async () => {
      const { connection, dispose } = harness<DataServerProtocol<ProbeElement>>();
      try {
         const panel = connection.createSession('panel', 'panel');
         panel.dispose();
         const unhandled = await unhandledDuring(async () => {
            void panel.openDocument({ uri: URI_A });
         });

         expect(unhandled).toHaveLength(1);
      } finally {
         dispose();
      }
   });
});
