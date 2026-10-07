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
   CancellationTokenSource,
   NotificationType,
   NotificationType0,
   NotificationType2,
   ParameterStructures,
   RequestType
} from 'vscode-jsonrpc';
import { sendByMethodName } from '../../src/rpc/send-by-method-name';
import { waitFor } from '../../src/testing';
import { makeDuplexConnectionPair } from '../../src/testing/node';

// Another copy's `auto` is a different object, which is all the connection compares.
const foreignAuto: ParameterStructures = Object.create(ParameterStructures.auto);

/** A connection that accepts any argument count, as JavaScript callers can pass. */
interface LooseSender {
   sendRequest<R>(method: string, ...params: unknown[]): Promise<R>;
   sendNotification(type: string | object, ...params: unknown[]): Promise<void>;
}

describe('sendByMethodName', () => {
   it('sends a notification typed by another copy of vscode-jsonrpc', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const received: unknown[] = [];
         pair.right.onNotification('test/notify', params => {
            received.push(params);
         });
         const type = new NotificationType<{ value: number }>('test/notify', foreignAuto);

         expect(() => pair.left.sendNotification(type, { value: 1 })).toThrow('Unknown parameter structure auto');
         await sendByMethodName(pair.left).sendNotification(type, { value: 2 });

         await waitFor(() => received.length > 0);
         expect(received).toEqual([{ value: 2 }]);
      } finally {
         pair.dispose();
      }
   });

   it('sends a request typed by another copy of vscode-jsonrpc', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         pair.right.onRequest('test/double', (params: { value: number }) => params.value * 2);
         const type = new RequestType<{ value: number }, number, void>('test/double', foreignAuto);

         await expect(sendByMethodName(pair.left).sendRequest(type, { value: 21 })).resolves.toBe(42);
      } finally {
         pair.dispose();
      }
   });

   it('sends a byName type with an object by name, as the LSP protocol types do', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const received: unknown[] = [];
         pair.right.onNotification('test/named', params => {
            received.push(params);
         });
         const type = new NotificationType<{ value: number }>('test/named', Object.create(ParameterStructures.byName));

         await sendByMethodName(pair.left).sendNotification(type, { value: 3 });

         await waitFor(() => received.length > 0);
         expect(received).toEqual([{ value: 3 }]);
      } finally {
         pair.dispose();
      }
   });

   it('sends a byPosition type with a non-object by position', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         pair.right.onRequest('test/increment', (value: number) => value + 1);
         const type = new RequestType<number, number, void>('test/increment', Object.create(ParameterStructures.byPosition));

         await expect(sendByMethodName(pair.left).sendRequest(type, 41)).resolves.toBe(42);
      } finally {
         pair.dispose();
      }
   });

   it('refuses a byPosition type with an object, which by method name would go by name', () => {
      const pair = makeDuplexConnectionPair();
      try {
         const type = new NotificationType<{ value: number }>('test/positional', Object.create(ParameterStructures.byPosition));

         expect(() => sendByMethodName(pair.left).sendNotification(type, { value: 1 })).toThrow(
            "sendByMethodName cannot send 'test/positional' byPosition"
         );
      } finally {
         pair.dispose();
      }
   });

   it('refuses a byName type with a non-object, which the typed send refuses too', () => {
      const pair = makeDuplexConnectionPair();
      try {
         const type = new RequestType<number, number, void>('test/named-number', Object.create(ParameterStructures.byName));

         expect(() => sendByMethodName(pair.left).sendRequest(type, 1)).toThrow("sendByMethodName cannot send 'test/named-number' byName");
      } finally {
         pair.dispose();
      }
   });

   it('sends a request with an undefined token as the typed send would, by name', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         // The catch-all handler sees the params as they went over the wire.
         const received: unknown[] = [];
         pair.right.onRequest((_method: string, params: unknown) => {
            received.push(params);
            return 'done';
         });
         const type = new RequestType<{ value: number }, string, void>('test/token', Object.create(ParameterStructures.byName));

         await expect(sendByMethodName(pair.left).sendRequest(type, { value: 1 }, undefined)).resolves.toBe('done');
         expect(received).toEqual([{ value: 1 }]);
      } finally {
         pair.dispose();
      }
   });

   it('sends a request with a real token, which cancels it on the receiving side', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         let started = false;
         pair.right.onRequest('test/wait', (params: { value: number }, token) => {
            started = true;
            return new Promise<number>(resolve => token.onCancellationRequested(() => resolve(params.value)));
         });
         const type = new RequestType<{ value: number }, number, void>('test/wait', foreignAuto);
         const source = new CancellationTokenSource();

         const response = sendByMethodName(pair.left).sendRequest(type, { value: 7 }, source.token);
         await waitFor(() => started);
         source.cancel();

         await expect(response).resolves.toBe(7);
      } finally {
         pair.dispose();
      }
   });

   it('sends a request whose payload looks like a cancellation token as the payload', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         pair.right.onRequest('test/token-shaped', (params: { value: number }) => params.value);
         const type = new RequestType<{ isCancellationRequested: boolean; onCancellationRequested: boolean; value: number }, number, void>(
            'test/token-shaped',
            foreignAuto
         );

         await expect(
            sendByMethodName(pair.left).sendRequest(type, { isCancellationRequested: false, onCancellationRequested: true, value: 42 })
         ).resolves.toBe(42);
      } finally {
         pair.dispose();
      }
   });

   it('packs a missing argument, extra arguments and several parameters as the typed send does', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const received: unknown[] = [];
         pair.right.onNotification((method, params) => {
            received.push([method, params]);
         });
         // Typed loosely on purpose: these argument counts are what the typed overloads reject.
         const wrapped = sendByMethodName<typeof pair.left, LooseSender>(pair.left);

         await wrapped.sendNotification(new NotificationType<{ value: number }>('test/missing', foreignAuto));
         await wrapped.sendNotification(new NotificationType<{ value: number }>('test/extra', foreignAuto), { value: 1 }, 'extra');
         await wrapped.sendNotification(new NotificationType2<number, number>('test/padded'), 1);
         await wrapped.sendNotification(new NotificationType0('test/none'), 'stray');

         await waitFor(() => received.length === 4);
         expect(received).toEqual([
            ['test/missing', [null]],
            ['test/extra', { value: 1 }],
            ['test/padded', [1, null]],
            ['test/none', undefined]
         ]);
      } finally {
         pair.dispose();
      }
   });

   it('leaves every other member to the connection', () => {
      const pair = makeDuplexConnectionPair();
      try {
         // No contextual type: the members below have to type-check on the connection's own type.
         const wrapped = sendByMethodName(pair.left);
         expect(wrapped.listen).toBe(pair.left.listen);
         expect(wrapped.onNotification).toBe(pair.left.onNotification);
         expect(wrapped.dispose).toBe(pair.left.dispose);
      } finally {
         pair.dispose();
      }
   });
});
