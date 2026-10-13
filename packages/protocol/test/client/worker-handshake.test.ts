/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import {
   isWorkerBootstrapMessage,
   isWorkerErrorMessage,
   isWorkerReadyMessage,
   WORKER_BOOTSTRAP_MESSAGE_TYPE,
   WORKER_ERROR_MESSAGE_TYPE,
   WORKER_READY_MESSAGE_TYPE,
   type TransferredMessagePort
} from '../../src/client';

/** A port-shaped object, enough for the guard, which reads nothing of it. */
function makePort(): TransferredMessagePort {
   return { postMessage: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, start: () => undefined };
}

describe('isWorkerBootstrapMessage', () => {
   it('accepts a bootstrap message carrying the head ports', () => {
      const message = { type: WORKER_BOOTSTRAP_MESSAGE_TYPE, ports: { lsp: makePort(), data: makePort(), glsp: makePort() } };

      expect(isWorkerBootstrapMessage(message)).toBe(true);
   });

   it.each([
      ['a string', 'hydranium/bootstrap'],
      ['null', null],
      ['another type', { type: 'hydranium/worker-error', ports: {} }],
      ['no ports', { type: WORKER_BOOTSTRAP_MESSAGE_TYPE }],
      ['null ports', { type: WORKER_BOOTSTRAP_MESSAGE_TYPE, ports: null }]
   ])('rejects %s', (_shape, value) => {
      expect(isWorkerBootstrapMessage(value)).toBe(false);
   });
});

describe('isWorkerErrorMessage', () => {
   it('accepts a report carrying a phase and a message', () => {
      expect(isWorkerErrorMessage({ type: WORKER_ERROR_MESSAGE_TYPE, phase: 'bootstrap', message: 'store refused' })).toBe(true);
   });

   it.each([
      ['a string', 'hydranium/worker-error'],
      ['another type', { type: WORKER_BOOTSTRAP_MESSAGE_TYPE, phase: 'bootstrap', message: 'x' }],
      ['no message text', { type: WORKER_ERROR_MESSAGE_TYPE, phase: 'bootstrap' }],
      ['no phase', { type: WORKER_ERROR_MESSAGE_TYPE, message: 'x' }]
   ])('rejects %s', (_shape, value) => {
      expect(isWorkerErrorMessage(value)).toBe(false);
   });
});

describe('isWorkerReadyMessage', () => {
   it('accepts the ready message', () => {
      expect(isWorkerReadyMessage({ type: WORKER_READY_MESSAGE_TYPE })).toBe(true);
   });

   it.each([
      ['a string', 'hydranium/ready'],
      ['null', null],
      ['another type', { type: WORKER_ERROR_MESSAGE_TYPE }]
   ])('rejects %s', (_shape, value) => {
      expect(isWorkerReadyMessage(value)).toBe(false);
   });
});
