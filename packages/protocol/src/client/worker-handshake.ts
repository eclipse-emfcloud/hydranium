/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The handshake between a page and the worker hosting its heads, shared by
 * both ends so neither can drift from the other.
 *
 * **Every head gets its own `MessagePort`; none is bound to the worker
 * global.** The heads share one worker so they share one Langium store, and
 * that makes the global contended: a head bound to it receives every other
 * head's traffic, since a JSON-RPC reader filters nothing. The global is
 * unusable even for a single head: GLSP's worker launcher posts its startup
 * handshake through the global `postMessage` regardless of the connection it
 * was configured with, a plain string no JSON-RPC reader can parse.
 *
 * The global therefore carries the host protocol: the bootstrap in, the ready
 * message and failure reports out, and whatever else the host adds for
 * itself. A message that belongs to a head belongs on that head's port.
 *
 * The ports are {@link TransferredMessagePort}s, because this package compiles
 * without the DOM lib and the structural type is also what rejects a `Worker`
 * or the worker global at an adopter's call site.
 */

import type { TransferredMessagePort } from './post-message-transport';

/** Discriminator of the bootstrap message a page posts on the worker global. */
export const WORKER_BOOTSTRAP_MESSAGE_TYPE = 'hydranium/bootstrap';

/** One transferred port per head. */
export interface HeadPorts {
   readonly lsp: TransferredMessagePort;
   readonly data: TransferredMessagePort;
   readonly glsp: TransferredMessagePort;
}

/** The one message the worker answers, by starting its heads on the ports. */
export interface WorkerBootstrapMessage {
   readonly type: typeof WORKER_BOOTSTRAP_MESSAGE_TYPE;
   readonly ports: HeadPorts;
}

export function isWorkerBootstrapMessage(value: unknown): value is WorkerBootstrapMessage {
   if (typeof value !== 'object' || value === null) {
      return false;
   }
   const candidate = value as Partial<WorkerBootstrapMessage>;
   return candidate.type === WORKER_BOOTSTRAP_MESSAGE_TYPE && typeof candidate.ports === 'object' && candidate.ports !== null;
}

/**
 * Discriminator of the message the worker posts on the global once every head
 * is up. Until it arrives, the page takes the `Worker`'s `error` event as a
 * worker that never started and ends the heads; after it, as an uncaught error
 * the worker runs on from, which it reports and keeps the heads through.
 */
export const WORKER_READY_MESSAGE_TYPE = 'hydranium/ready';

export interface WorkerReadyMessage {
   /** The only field {@link isWorkerReadyMessage} checks, so {@link workspace} is taken on trust. */
   readonly type: typeof WORKER_READY_MESSAGE_TYPE;
   /** The files the heads came up on, when the worker's host named a root to read them under. */
   readonly workspace?: WorkerWorkspace;
}

/**
 * What the worker's filesystem holds under {@link rootUri} once its heads are
 * up, which is what a page opens its editors on: once a store can differ from
 * the seed, an editor opened on the seed overwrites the restored document.
 */
export interface WorkerWorkspace {
   /** The root the worker's host was given. */
   readonly rootUri: string;
   /** Every file's content, keyed by its path relative to {@link rootUri}. */
   readonly files: Readonly<Record<string, string>>;
   /** The paths of {@link files} that came out of the store rather than the seed. */
   readonly restored: readonly string[];
}

export function isWorkerReadyMessage(value: unknown): value is WorkerReadyMessage {
   return typeof value === 'object' && value !== null && (value as Partial<WorkerReadyMessage>).type === WORKER_READY_MESSAGE_TYPE;
}

/**
 * Discriminator of a failure report the worker posts on the global.
 *
 * A worker has no console anyone is looking at, and the failures that matter
 * most reach nobody by default: a workspace walk that throws has no reply to
 * reject, so it looks exactly like a workspace with no documents in it.
 */
export const WORKER_ERROR_MESSAGE_TYPE = 'hydranium/worker-error';

/** The phase a failed bootstrap reports under; no head answers after it. */
export const WORKER_BOOTSTRAP_PHASE = 'bootstrap';

export interface WorkerErrorMessage {
   /** The page raises this type too, on its own error event, when the `Worker` fires `error`. */
   readonly type: typeof WORKER_ERROR_MESSAGE_TYPE;
   /** What the worker was doing, {@link WORKER_BOOTSTRAP_PHASE} for a failed bootstrap. */
   readonly phase: string;
   /** The failure described for a log. Never branch on it. */
   readonly message: string;
}

export function isWorkerErrorMessage(value: unknown): value is WorkerErrorMessage {
   if (typeof value !== 'object' || value === null) {
      return false;
   }
   const candidate = value as Partial<WorkerErrorMessage>;
   return candidate.type === WORKER_ERROR_MESSAGE_TYPE && typeof candidate.phase === 'string' && typeof candidate.message === 'string';
}
