/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The socket driver against a minimal GLSP-shaped JSON-RPC peer on a real TCP
 * socket. The peer answers each `process` with `<kind>Reply` to the sender's
 * session and with a decoy to another session, so a driver that did not filter
 * by session would resolve on the decoy.
 */

import * as net from 'node:net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import { waitFor } from '@hydranium/protocol/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectGlspSocketDriver, type GlspSocketDriver } from '../src/glsp/node/index.js';

type Act = { readonly kind: string };

interface SessionMessage {
   readonly clientId: string;
   readonly action: Act;
}

const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
let peer: net.Server;
let port: number;

beforeAll(async () => {
   peer = net.createServer(socket => {
      const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
      connection.onError(() => undefined);
      connection.onRequest((method: string, params: unknown) => {
         requests.push({ method, params });
         const silent = typeof params === 'object' && params !== null && 'applicationId' in params && params.applicationId === 'silent';
         return silent ? new Promise(() => undefined) : {};
      });
      connection.onNotification('process', (message: SessionMessage) => {
         if (message.action.kind === 'hangUp') {
            socket.destroy();
            return;
         }
         void connection.sendNotification('process', { clientId: 'another-session', action: { kind: `${message.action.kind}Reply` } });
         void connection.sendNotification('process', {
            clientId: message.clientId,
            action: { kind: `${message.action.kind}Reply`, mine: true }
         });
      });
      connection.listen();
   });
   await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
   const address = peer.address();
   if (address === null || typeof address === 'string') {
      throw new Error('peer has no TCP address');
   }
   port = address.port;
});

afterAll(async () => {
   await new Promise<void>(resolve => peer.close(() => resolve()));
});

function connect(clientSessionId?: string): Promise<GlspSocketDriver<Act>> {
   return connectGlspSocketDriver<Act>({
      port,
      diagramType: 'type-one',
      clientActionKinds: ['echoReply'],
      clientSessionId,
      timeoutMs: 500
   });
}

describe('connectGlspSocketDriver', () => {
   it('opens the session it was configured for', async () => {
      const driver = await connect('session-one');
      try {
         const from = requests.length;
         await driver.start();
         expect(requests.slice(from)).toEqual([
            { method: 'initialize', params: expect.objectContaining({ protocolVersion: expect.any(String) }) },
            {
               method: 'initializeClientSession',
               params: { clientSessionId: 'session-one', diagramType: 'type-one', clientActionKinds: ['echoReply'] }
            }
         ]);
      } finally {
         driver.dispose();
      }
   });

   it("resolves only on its own session's action, and keeps every one it received", async () => {
      const driver = await connect();
      try {
         await driver.start();
         driver.dispatch({ kind: 'echo' });
         expect(await driver.nextAction('echoReply')).toEqual({ kind: 'echoReply', mine: true });
         expect(driver.actions).toHaveLength(1);
      } finally {
         driver.dispose();
      }
   });

   it('rejects a wait that times out, naming what did arrive', async () => {
      const driver = await connect();
      try {
         await driver.start();
         driver.dispatch({ kind: 'echo' });
         await driver.nextAction('echoReply');
         await expect(driver.nextAction('neverSent', 50)).rejects.toThrow(/No 'neverSent' action within 50ms .*received: echoReply/);
      } finally {
         driver.dispose();
      }
   });

   it('sends back what respond returns for a received action', async () => {
      const driver = await connectGlspSocketDriver<Act>({
         port,
         diagramType: 'type-one',
         clientActionKinds: [],
         respond: action => (action.kind === 'echoReply' ? { kind: 'answer' } : undefined)
      });
      try {
         await driver.start();
         driver.dispatch({ kind: 'echo' });
         // The peer echoes the reply too, which is how it is seen arriving.
         expect(await driver.nextAction('answerReply')).toEqual({ kind: 'answerReply', mine: true });
      } finally {
         driver.dispose();
      }
   });

   it('does not count what respond sends as a dispatch', async () => {
      const driver = await connectGlspSocketDriver<Act>({
         port,
         diagramType: 'type-one',
         clientActionKinds: [],
         respond: action => (action.kind === 'echoReply' ? { kind: 'answer' } : undefined),
         timeoutMs: 500
      });
      try {
         await driver.start();
         driver.dispatch({ kind: 'echo' });
         await waitFor(() => driver.actions.some(action => action.kind === 'answerReply'));
         // The reply went out after echoReply arrived; as a dispatch it would
         // have put echoReply before the mark.
         expect(await driver.nextAction('echoReply')).toEqual({ kind: 'echoReply', mine: true });
      } finally {
         driver.dispose();
      }
   });

   it('waits only for an action that arrived after the last dispatch', async () => {
      const driver = await connect();
      try {
         await driver.start();
         driver.dispatch({ kind: 'echo' });
         await waitFor(() => driver.actions.some(action => action.kind === 'echoReply'));
         driver.dispatch({ kind: 'other' });

         expect(await driver.nextAction('otherReply')).toEqual({ kind: 'otherReply', mine: true });
         // Arrived before the last dispatch, so it is no answer to it.
         await expect(driver.nextAction('echoReply', 100)).rejects.toThrow(
            /No 'echoReply' action within 100ms .*received before the last dispatch, which a wait does not match: echoReply; since: otherReply/
         );
      } finally {
         driver.dispose();
      }
   });

   it('fails the pending wait, and any later one, with what respond threw', async () => {
      const driver = await connectGlspSocketDriver<Act>({
         port,
         diagramType: 'type-one',
         clientActionKinds: [],
         respond: action => {
            if (action.kind === 'echoReply') {
               throw new Error('fixture bug');
            }
            return undefined;
         }
      });
      try {
         await driver.start();
         const waiting = driver.nextAction('answerReply', 5_000);
         driver.dispatch({ kind: 'echo' });
         await expect(waiting).rejects.toThrow(/respond threw on 'echoReply' \(Error: fixture bug\) while waiting for 'answerReply'/);
         await expect(driver.nextAction('answerReply', 5_000)).rejects.toThrow(/respond threw on 'echoReply'/);
      } finally {
         driver.dispose();
      }
   });

   it('announces the protocol version it was given', async () => {
      const driver = await connectGlspSocketDriver<Act>({ port, diagramType: 'type-one', clientActionKinds: [], protocolVersion: '9.9.9' });
      try {
         const from = requests.length;
         await driver.start();
         expect(requests[from]).toEqual({ method: 'initialize', params: expect.objectContaining({ protocolVersion: '9.9.9' }) });
      } finally {
         driver.dispose();
      }
   });

   it('fails start() naming the request a server never answers', async () => {
      const driver = await connectGlspSocketDriver<Act>({
         port,
         diagramType: 'type-one',
         clientActionKinds: [],
         applicationId: 'silent',
         timeoutMs: 100
      });
      try {
         await expect(driver.start()).rejects.toThrow(/did not answer 'initialize' within 100ms/);
      } finally {
         driver.dispose();
      }
   });

   it('fails a pending wait, and any later one, when the driver is disposed', async () => {
      const driver = await connect();
      await driver.start();
      const waiting = driver.nextAction('neverSent', 5_000);
      driver.dispose();
      await expect(waiting).rejects.toThrow(/closed while waiting for 'neverSent'/);
      await expect(driver.nextAction('neverSent', 5_000)).rejects.toThrow(/closed; no 'neverSent' action can arrive/);
   });

   it('fails a pending wait as soon as the server closes the connection', async () => {
      const driver = await connect();
      try {
         await driver.start();
         const waiting = driver.nextAction('echoReply', 5_000);
         driver.dispatch({ kind: 'hangUp' });
         await expect(waiting).rejects.toThrow(/closed while waiting for 'echoReply'/);
         expect(() => driver.dispatch({ kind: 'echo' })).not.toThrow();
         await expect(driver.nextAction('echoReply')).rejects.toThrow(/closed; no 'echoReply' action can arrive/);
      } finally {
         driver.dispose();
      }
   });
});
