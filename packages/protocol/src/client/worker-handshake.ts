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
 * The global therefore carries the host protocol: the bootstrap in, failure
 * reports out, and whatever else the host adds for itself. A message that
 * belongs to a head belongs on that head's port.
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
 * Discriminator of a failure report the worker posts on the global.
 *
 * A worker has no console anyone is looking at, and the failures that matter
 * most reach nobody by default: an LSP notification handler that rejects has
 * no reply to reject, so a workspace walk that throws looks exactly like a
 * workspace with no documents in it.
 */
export const WORKER_ERROR_MESSAGE_TYPE = 'hydranium/worker-error';

/** The phase a failed bootstrap reports under; no head answers after it. */
export const WORKER_BOOTSTRAP_PHASE = 'bootstrap';

export interface WorkerErrorMessage {
   readonly type: typeof WORKER_ERROR_MESSAGE_TYPE;
   /** What the worker was doing, {@link WORKER_BOOTSTRAP_PHASE} for a failed bootstrap. */
   readonly phase: string;
   readonly message: string;
}

export function isWorkerErrorMessage(value: unknown): value is WorkerErrorMessage {
   if (typeof value !== 'object' || value === null) {
      return false;
   }
   const candidate = value as Partial<WorkerErrorMessage>;
   return candidate.type === WORKER_ERROR_MESSAGE_TYPE && typeof candidate.phase === 'string' && typeof candidate.message === 'string';
}
