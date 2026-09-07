/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { makeDuplexStreamPair } from '../../src/testing/node';

/** Read one chunk off a PassThrough as a Promise. */
function nextChunk(stream: NodeJS.ReadableStream): Promise<Buffer> {
   return new Promise(resolve => stream.once('data', chunk => resolve(chunk as Buffer)));
}

describe('makeDuplexStreamPair', () => {
   it('carries each direction independently — what is written is read back on the same PassThrough', async () => {
      const pair = makeDuplexStreamPair();
      try {
         const clientPayload = Buffer.from('from-client');
         const serverPayload = Buffer.from('from-server');

         const clientToServerRead = nextChunk(pair.clientToServer);
         const serverToClientRead = nextChunk(pair.serverToClient);

         pair.clientToServer.write(clientPayload);
         pair.serverToClient.write(serverPayload);

         expect((await clientToServerRead).equals(clientPayload)).toBe(true);
         expect((await serverToClientRead).equals(serverPayload)).toBe(true);
      } finally {
         pair.dispose();
      }
   });

   it('dispose() destroys both streams', () => {
      const pair = makeDuplexStreamPair();
      expect(pair.clientToServer.destroyed).toBe(false);
      expect(pair.serverToClient.destroyed).toBe(false);

      pair.dispose();

      expect(pair.clientToServer.destroyed).toBe(true);
      expect(pair.serverToClient.destroyed).toBe(true);
   });

   it('dispose() is idempotent — a second call is a clean no-op', () => {
      const pair = makeDuplexStreamPair();
      pair.dispose();
      expect(() => pair.dispose()).not.toThrow();
      expect(pair.clientToServer.destroyed).toBe(true);
      expect(pair.serverToClient.destroyed).toBe(true);
   });
});
