/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ConnectionError, ConnectionErrors } from 'vscode-jsonrpc';
import { describe, expect, it } from 'vitest';
import { dropNotificationsToGoneClient } from '../src/index.js';
import { makeCapturingGlspLogger } from '../src/testing/index.js';

describe('dropNotificationsToGoneClient', () => {
   it('drops a write to a client that disconnected, at debug, and leaves the rest of the connection alone', async () => {
      const { logger, lines } = makeCapturingGlspLogger();
      const connection = {
         sendNotification: (_method: string, ..._params: unknown[]): Promise<void> =>
            Promise.reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
         sendRequest: (method: string): Promise<string> => Promise.resolve(`answered ${method}`)
      };
      const guarded = dropNotificationsToGoneClient(connection, logger);

      await expect(guarded.sendNotification('process', {})).resolves.toBeUndefined();
      expect(lines).toEqual([
         { level: 'debug', message: 'Dropped a notification to a client that has gone: Error: write EPIPE', params: [] }
      ]);
      expect(await guarded.sendRequest('initialize')).toBe('answered initialize');
   });

   it('drops a send to a disposed connection, which throws rather than rejecting', async () => {
      const { logger, lines } = makeCapturingGlspLogger();
      const connection = {
         sendNotification: (_method: string, ..._params: unknown[]): Promise<void> => {
            throw new ConnectionError(ConnectionErrors.Disposed, 'Connection is disposed.');
         }
      };
      const guarded = dropNotificationsToGoneClient(connection, logger);

      await expect(guarded.sendNotification('process', {})).resolves.toBeUndefined();
      expect(lines.map(line => line.level)).toEqual(['debug']);
   });

   it('leaves any other failure to reject or throw as it did', async () => {
      const { logger, lines } = makeCapturingGlspLogger();
      const rejecting = dropNotificationsToGoneClient(
         { sendNotification: (_method: string, ..._params: unknown[]): Promise<void> => Promise.reject(new Error('write failed')) },
         logger
      );
      const throwing = dropNotificationsToGoneClient(
         {
            sendNotification: (_method: string, ..._params: unknown[]): Promise<void> => {
               throw new Error('Unknown parameter structure auto');
            }
         },
         logger
      );

      await expect(rejecting.sendNotification('process', {})).rejects.toThrow('write failed');
      expect(() => throwing.sendNotification('process', {})).toThrow('Unknown parameter structure auto');
      expect(lines).toEqual([]);
   });
});
