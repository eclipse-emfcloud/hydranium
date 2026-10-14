/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { findPort } from '../src/node/find-port';

/** A client whose answers to the port request are scripted, one per call. */
function scriptedClient(answers: Array<number | Error | undefined>) {
   const requests: string[] = [];
   return {
      requests,
      sendRequest<R>(method: string): Promise<R> {
         requests.push(method);
         const answer = answers.shift();
         return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as R);
      }
   };
}

describe('findPort', () => {
   it('retries until the server answers with a port', async () => {
      const client = scriptedClient([new Error('Unhandled method a/port'), undefined, 4711]);

      await expect(findPort(client, 'a/port', { intervalMs: 0 })).resolves.toBe(4711);
      expect(client.requests).toEqual(['a/port', 'a/port', 'a/port']);
   });

   it('rejects with the last error once the attempts are spent', async () => {
      const client = scriptedClient([new Error('first'), new Error('Unhandled method a/port')]);

      await expect(findPort(client, 'a/port', { attempts: 2, intervalMs: 0 })).rejects.toThrow(
         `No port answered 'a/port' after 2 attempts. Check that the server publishes it. The last attempt failed: Unhandled method a/port`
      );
      expect(client.requests).toHaveLength(2);
   });

   it.for([0, -1, 1.5, Number.NaN])('refuses %s attempts without sending a request', async attempts => {
      const client = scriptedClient([4711]);

      await expect(findPort(client, 'a/port', { attempts })).rejects.toThrow(RangeError);
      expect(client.requests).toEqual([]);
   });

   it('treats a zero port as no answer', async () => {
      const client = scriptedClient([0]);

      await expect(findPort(client, 'a/port', { attempts: 1, intervalMs: 0 })).rejects.toThrow(
         new Error(`No port answered 'a/port' after 1 attempt. Check that the server publishes it.`)
      );
   });
});
