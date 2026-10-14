/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   createMessagePortTransport,
   Deferred,
   isWorkerErrorMessage,
   isWorkerReadyMessage,
   WORKER_BOOTSTRAP_MESSAGE_TYPE,
   WORKER_BOOTSTRAP_PHASE,
   WORKER_ERROR_MESSAGE_TYPE,
   type DataPort,
   type Logger,
   type TransferredMessagePort,
   type WorkerBootstrapMessage,
   type WorkerErrorMessage,
   type WorkerReadyMessage
} from '@hydranium/protocol';
import { createMessageConnection, Emitter, type Disposable, type Event, type MessageConnection } from 'vscode-jsonrpc/browser';
import { WorkerDataPort } from './worker-data-port';

/** The phase a report synthesised from the `Worker`'s `error` event carries. */
export const WORKER_ERROR_EVENT_PHASE = 'worker';

export interface WorkerHeadsOptions {
   /** Where each head's connection logs its protocol faults, one component per head. Without one they log nothing. */
   readonly logger?: Logger;
   /**
    * Build the data head's port over the page's end of its `MessagePort`, a
    * {@link WorkerDataPort} by default. A host with a surface of its own for
    * data-head failures supplies a subclass here.
    */
   readonly createDataPort?: (port: TransferredMessagePort, logger?: Logger) => DataPort & Disposable;
}

/** The page's end of each head, and what the worker says outside any head. */
export interface WorkerHeads {
   /**
    * The LSP head's connection, not yet listening: register the handlers for
    * the server's first requests, then `listen()` and send `initialize`. A
    * message that arrives before `listen` is dropped.
    */
   readonly lsp: MessageConnection;
   /** The data head's port, for a `DataConnection`. */
   readonly data: DataPort;
   /**
    * The GLSP head's connection, not listening: GLSP's client calls `listen()`
    * when it starts, and a second call throws. Its port is started, so a
    * message arriving before then is dropped; the GLSP head posts nothing on
    * its port before the client speaks. Hand it to that client wrapped with
    * `sendByMethodName`, where the client's own connection type is named:
    * GLSP's typed messages come from its own copy of `vscode-jsonrpc`, and
    * this connection's copy rejects them unless they go by method name.
    */
   readonly glsp: MessageConnection;
   /**
    * The worker's ready message, once every head is up, with the files the
    * worker holds when its host named a root for them. Rejects when the heads
    * end first; stays pending for a worker that posts no ready message.
    */
   readonly ready: Promise<WorkerReadyMessage>;
   /**
    * Every failure the worker reports on its global, and its `error` event
    * under {@link WORKER_ERROR_EVENT_PHASE}, before and after the heads have
    * ended. Whether a report ended them is {@link onDispose}'s to say.
    */
   readonly onWorkerError: Event<WorkerErrorMessage>;
   /**
    * Fires once when the heads end: on a failed bootstrap, on an `error` event
    * before the worker is known to be up, or on {@link dispose}. What the heads
    * had pending is rejected then rather than left waiting. The worker is up
    * once it has posted its ready message, or anything on a head's port for a
    * worker that posts no ready message. Any later report, and an `error`
    * event once the worker is up, ends nothing: the worker runs on after an
    * uncaught error, and the heads with it. Subscribe before the first
    * `await`: the end fires once, and a subscriber after it hears nothing.
    */
   readonly onDispose: Event<void>;
   /** End every head. A head whose connection exists signals its close to the worker, which ends the head there. */
   dispose(): void;
}

/**
 * Hand each head its own channel into `worker` and build the page's end of
 * each.
 *
 * The worker keeps `port2` of every pair and the page `port1`; neither end is
 * given the worker global, which carries the bootstrap, the worker's ready
 * message and failure reports, and whatever the host adds for itself. See the
 * handshake in `@hydranium/protocol` for why a head on the global is unusable.
 *
 * **A port reports nothing when its peer dies**, so a worker that fails to
 * load, throws before its bootstrap or fails it would leave every request on
 * every head waiting forever, which looks exactly like a server still working.
 * Those signals dispose the heads instead, and disposing a connection is what
 * rejects its pending requests; a close alone does not. A worker that dies
 * later still cannot be told from one that is working.
 */
export function connectWorkerHeads(worker: Worker, options: WorkerHeadsOptions = {}): WorkerHeads {
   const lsp = new MessageChannel();
   const data = new MessageChannel();
   const glsp = new MessageChannel();
   const bootstrap: WorkerBootstrapMessage = {
      type: WORKER_BOOTSTRAP_MESSAGE_TYPE,
      ports: { lsp: lsp.port2, data: data.port2, glsp: glsp.port2 }
   };
   worker.postMessage(bootstrap, [lsp.port2, data.port2, glsp.port2]);

   // Both ends use `createMessagePortTransport`; see it for why.
   const lspTransport = createMessagePortTransport(lsp.port1);
   const lspConnection = createMessageConnection(lspTransport.reader, lspTransport.writer, options.logger?.with('LSP head'));
   const dataLogger = options.logger?.with('data head');
   const dataPort = options.createDataPort?.(data.port1, dataLogger) ?? new WorkerDataPort(data.port1, dataLogger);
   const glspTransport = createMessagePortTransport(glsp.port1);
   const glspConnection = createMessageConnection(glspTransport.reader, glspTransport.writer, options.logger?.with('GLSP head'));
   const errorEmitter = new Emitter<WorkerErrorMessage>();
   const disposeEmitter = new Emitter<void>();
   const ready = new Deferred<WorkerReadyMessage>();
   // A page that never reads it must not see the rejection as unhandled.
   ready.promise.catch(() => undefined);

   // Whether the worker is past its bootstrap: it says so with its ready
   // message, and a worker that posts none shows it by posting on a head's
   // port, which only a running head does. An `error` event before that is a
   // worker that never started; one after it is an uncaught error the worker
   // survives.
   let workerUp = false;
   for (const port of [lsp.port1, data.port1, glsp.port1]) {
      port.addEventListener('message', () => (workerUp = true), { once: true });
   }

   let disposed = false;
   const dispose = (): void => {
      if (disposed) {
         return;
      }
      disposed = true;
      lspConnection.dispose();
      dataPort.dispose();
      glspConnection.dispose();
      ready.reject(new Error('The worker heads ended before the worker was ready'));
      disposeEmitter.fire();
      disposeEmitter.dispose();
   };

   // A worker that failed to load raises an event with no message, filename or
   // line, indistinguishable from a crash on its first statement; the host
   // adds the URL it tried.
   worker.addEventListener('error', event => {
      errorEmitter.fire({
         type: WORKER_ERROR_MESSAGE_TYPE,
         phase: WORKER_ERROR_EVENT_PHASE,
         message: event.message || 'no detail; check that the worker script loaded'
      });
      if (!workerUp) {
         dispose();
      }
   });
   worker.addEventListener('message', event => {
      if (isWorkerReadyMessage(event.data)) {
         workerUp = true;
         ready.resolve(event.data);
         return;
      }
      if (!isWorkerErrorMessage(event.data)) {
         return;
      }
      errorEmitter.fire(event.data);
      if (event.data.phase === WORKER_BOOTSTRAP_PHASE) {
         dispose();
      }
   });

   return {
      lsp: lspConnection,
      data: dataPort,
      glsp: glspConnection,
      ready: ready.promise,
      onWorkerError: errorEmitter.event,
      onDispose: disposeEmitter.event,
      dispose
   };
}
