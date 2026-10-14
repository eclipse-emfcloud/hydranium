/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page's end of the worker handshake, headless: a worker-shaped recorder
 * stands in for the `Worker`, and Node's own `MessageChannel` supplies the
 * ports the page transfers.
 */

import {
   createMessagePortTransport,
   isWorkerBootstrapMessage,
   NoopLogger,
   WORKER_BOOTSTRAP_PHASE,
   WORKER_ERROR_MESSAGE_TYPE,
   WORKER_READY_MESSAGE_TYPE,
   type TransferredMessagePort,
   type WorkerBootstrapMessage,
   type WorkerErrorMessage
} from '@hydranium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from '@hydranium/protocol/testing';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';
import { connectWorkerHeads, WorkerDataPort, type WorkerHeads } from '../src';

type Listener = (event: unknown) => void;

/** What the page posted, and the listeners it registered, with a way to fire them. */
class RecordingWorker {
   readonly posted: { message: unknown; transfer: readonly unknown[] }[] = [];
   protected readonly listeners = new Map<string, Listener[]>();

   postMessage(message: unknown, transfer: readonly unknown[] = []): void {
      this.posted.push({ message, transfer });
   }

   addEventListener(type: string, listener: Listener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
   }

   fire(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
         listener(event);
      }
   }

   /** The bootstrap the page posted, which the worker's end would answer. */
   get bootstrap(): WorkerBootstrapMessage {
      const message = this.posted[0]?.message;
      if (!isWorkerBootstrapMessage(message)) {
         throw new Error('no bootstrap message was posted');
      }
      return message;
   }

   asWorker(): Worker {
      return this as unknown as Worker;
   }
}

const toDispose: { dispose(): void }[] = [];

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
});

/** The worker's end of one head: a listening connection over the transferred port. */
function makeHeadEnd(port: TransferredMessagePort): MessageConnection {
   const transport = createMessagePortTransport(port);
   const connection = createMessageConnection(transport.reader, transport.writer, new NoopLogger());
   connection.listen();
   toDispose.push(connection);
   return connection;
}

function connect(worker: RecordingWorker): WorkerHeads {
   const heads = connectWorkerHeads(worker.asWorker(), { logger: new NoopLogger() });
   toDispose.push(heads);
   return heads;
}

/** A request the page sends and nothing answers, so only a rejection can settle it. */
function sendUnanswered(connection: MessageConnection): Promise<unknown> {
   const pending = connection.sendRequest('head/unanswered');
   // Marked handled: a rejection that arrives after the assertion would
   // otherwise fail the run as unhandled.
   pending.catch(() => undefined);
   return pending;
}

function errorReport(phase: string): WorkerErrorMessage {
   return { type: WORKER_ERROR_MESSAGE_TYPE, phase, message: 'it broke' };
}

describe('connectWorkerHeads', () => {
   it('posts one bootstrap message, transferring a port per head', () => {
      const worker = new RecordingWorker();
      connect(worker);

      expect(worker.posted).toHaveLength(1);
      const { ports } = worker.bootstrap;
      expect(worker.posted[0].transfer).toEqual([ports.lsp, ports.data, ports.glsp]);
      expect(new Set(Object.values(ports)).size).toBe(3);
   });

   it('carries an LSP request to the worker end of the LSP port', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const head = makeHeadEnd(worker.bootstrap.ports.lsp);
      head.onRequest('head/echo', (value: unknown) => ({ echoed: value }));
      heads.lsp.listen();

      await expect(heads.lsp.sendRequest('head/echo', 'one')).resolves.toEqual({ echoed: 'one' });
   });

   it('hands the data head a port whose connection reaches the worker end of the data port', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const head = makeHeadEnd(worker.bootstrap.ports.data);
      head.onRequest('head/echo', (value: unknown) => ({ echoed: value }));

      const connection = await heads.data.connect();

      await expect(connection.sendRequest('head/echo', 'two')).resolves.toEqual({ echoed: 'two' });
   });

   it('hands the GLSP head a connection that is not yet listening, since its client listens', () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);

      expect(() => heads.glsp.listen()).not.toThrow();
   });

   it("rejects every head's pending request when the worker reports an error event", async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      heads.lsp.listen();
      heads.glsp.listen();
      const reported: WorkerErrorMessage[] = [];
      heads.onWorkerError(report => reported.push(report));
      const lsp = sendUnanswered(heads.lsp);
      const data = sendUnanswered(await heads.data.connect());
      const glsp = sendUnanswered(heads.glsp);

      let ended = 0;
      heads.onDispose(() => ended++);

      worker.fire('error', { message: 'script failed on line 1' });

      await expect(lsp).rejects.toThrow('disposed');
      await expect(data).rejects.toThrow('disposed');
      await expect(glsp).rejects.toThrow('disposed');
      expect(reported.map(report => report.message)).toEqual(['script failed on line 1']);
      expect(ended).toBe(1);
   });

   it('reports an error event that carries no message as the script not loading', () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const reported: WorkerErrorMessage[] = [];
      heads.onWorkerError(report => reported.push(report));

      worker.fire('error', { message: '' });

      expect(reported).toEqual([
         { type: WORKER_ERROR_MESSAGE_TYPE, phase: 'worker', message: 'no detail; check that the worker script loaded' }
      ]);
   });

   it('reports an error event after a head has answered, and ends nothing, since the worker runs on', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const head = makeHeadEnd(worker.bootstrap.ports.lsp);
      head.onRequest('head/echo', (value: unknown) => ({ echoed: value }));
      heads.lsp.listen();
      await heads.lsp.sendRequest('head/echo', 'up');
      const reported: WorkerErrorMessage[] = [];
      heads.onWorkerError(report => reported.push(report));
      const pending = sendUnanswered(heads.lsp);

      worker.fire('error', { message: 'a handler threw' });

      expect(reported.map(report => report.message)).toEqual(['a handler threw']);
      await expect(heads.lsp.sendRequest('head/echo', 'still up')).resolves.toEqual({ echoed: 'still up' });
      await tick();
      expect(
         await Promise.race([
            pending.then(
               () => 'settled',
               () => 'settled'
            ),
            Promise.resolve('pending')
         ])
      ).toBe('pending');
   });

   it('counts an answer on the data port as the worker being up', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const head = makeHeadEnd(worker.bootstrap.ports.data);
      head.onRequest('head/echo', (value: unknown) => ({ echoed: value }));
      const data = await heads.data.connect();
      await data.sendRequest('head/echo', 'up');
      let ended = 0;
      heads.onDispose(() => ended++);

      worker.fire('error', { message: 'a handler threw' });

      expect(ended).toBe(0);
      await expect(data.sendRequest('head/echo', 'still up')).resolves.toEqual({ echoed: 'still up' });
   });

   it('reports an error event after the ready message, and ends nothing, since the heads are up', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      heads.lsp.listen();
      const reported: WorkerErrorMessage[] = [];
      heads.onWorkerError(report => reported.push(report));
      let ended = 0;
      heads.onDispose(() => ended++);
      const pending = sendUnanswered(heads.lsp);

      worker.fire('message', { data: { type: WORKER_READY_MESSAGE_TYPE } });
      worker.fire('error', { message: 'a handler threw' });

      expect(reported.map(report => report.message)).toEqual(['a handler threw']);
      expect(ended).toBe(0);
      await tick();
      expect(
         await Promise.race([
            pending.then(
               () => 'settled',
               () => 'settled'
            ),
            Promise.resolve('pending')
         ])
      ).toBe('pending');
   });

   it('resolves ready with the ready message, workspace included', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const message = { type: WORKER_READY_MESSAGE_TYPE, workspace: { rootUri: 'file:///w', files: { 'a.x': 'text' }, restored: ['a.x'] } };

      worker.fire('message', { data: message });

      await expect(heads.ready).resolves.toEqual(message);
   });

   it('rejects ready when a failed bootstrap ends the heads first', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);

      worker.fire('message', { data: errorReport(WORKER_BOOTSTRAP_PHASE) });

      await expect(heads.ready).rejects.toThrow('ended before the worker was ready');
   });

   it('keeps ready resolved when the heads end after it', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);

      worker.fire('message', { data: { type: WORKER_READY_MESSAGE_TYPE } });
      heads.dispose();

      await expect(heads.ready).resolves.toEqual({ type: WORKER_READY_MESSAGE_TYPE });
   });

   it('rejects pending requests on a failed bootstrap report', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      heads.lsp.listen();
      const lsp = sendUnanswered(heads.lsp);

      worker.fire('message', { data: errorReport(WORKER_BOOTSTRAP_PHASE) });

      await expect(lsp).rejects.toThrow('disposed');
   });

   it('only reports a failure in any later phase, leaving the heads up', async () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const head = makeHeadEnd(worker.bootstrap.ports.lsp);
      head.onRequest('head/echo', (value: unknown) => ({ echoed: value }));
      heads.lsp.listen();
      const reported: WorkerErrorMessage[] = [];
      heads.onWorkerError(report => reported.push(report));

      worker.fire('message', { data: errorReport('workspace validation') });

      expect(reported).toEqual([errorReport('workspace validation')]);
      await expect(heads.lsp.sendRequest('head/echo', 'three')).resolves.toEqual({ echoed: 'three' });
   });

   it('fires onDispose once when a failed bootstrap ends the heads', () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      let ended = 0;
      heads.onDispose(() => ended++);

      worker.fire('message', { data: errorReport(WORKER_BOOTSTRAP_PHASE) });
      worker.fire('message', { data: errorReport(WORKER_BOOTSTRAP_PHASE) });
      heads.dispose();

      expect(ended).toBe(1);
   });

   it('fires onDispose on an explicit dispose', () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      let ended = 0;
      heads.onDispose(() => ended++);

      heads.dispose();

      expect(ended).toBe(1);
   });

   it('still reports a failure posted after the heads ended', () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const reported: WorkerErrorMessage[] = [];
      heads.onWorkerError(report => reported.push(report));
      worker.fire('message', { data: errorReport(WORKER_BOOTSTRAP_PHASE) });

      worker.fire('message', { data: errorReport('unhandled rejection') });

      expect(reported.map(report => report.phase)).toEqual([WORKER_BOOTSTRAP_PHASE, 'unhandled rejection']);
   });

   it('builds the data port through createDataPort, so a host can bring its own', async () => {
      const worker = new RecordingWorker();
      let built = 0;
      const heads = connectWorkerHeads(worker.asWorker(), {
         createDataPort: (port, logger) => {
            built++;
            return new WorkerDataPort(port, logger);
         }
      });
      toDispose.push(heads);
      const head = makeHeadEnd(worker.bootstrap.ports.data);
      head.onRequest('head/echo', (value: unknown) => ({ echoed: value }));

      const connection = await heads.data.connect();

      expect(built).toBe(1);
      await expect(connection.sendRequest('head/echo', 'own')).resolves.toEqual({ echoed: 'own' });
   });

   it('leaves a message that is no report to the host', () => {
      const worker = new RecordingWorker();
      const heads = connect(worker);
      const reported: WorkerErrorMessage[] = [];
      heads.onWorkerError(report => reported.push(report));

      worker.fire('message', { data: { type: 'host/workspace-ready', files: {} } });

      expect(reported).toEqual([]);
   });
});
