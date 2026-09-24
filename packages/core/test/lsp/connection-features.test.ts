/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { tick } from '@hydranium/protocol/testing';
import { PassThrough } from 'node:stream';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { LogMessageNotification, MessageType, type Connection, type Features, type RemoteConsole } from 'vscode-languageserver';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { describe, expect, it, vi } from 'vitest';
import { withHydraniumLspFeatures } from '../../src/lsp/connection-features.js';
import { captureUnhandledRejections } from '../../src/testing/node/unhandled-rejections.js';

function makeConsole(sendNotification: Connection['sendNotification']): RemoteConsole {
   class BaseConsole {
      readonly connection = { sendNotification } as unknown as Connection;
   }

   const features = withHydraniumLspFeatures({ __brand: 'features' } as Features);
   const Console = features.console!(BaseConsole as unknown as new () => RemoteConsole);
   return new Console();
}

function makeRealConnection(): Connection {
   return createConnection(
      withHydraniumLspFeatures(ProposedFeatures.all),
      new StreamMessageReader(new PassThrough()),
      new StreamMessageWriter(new PassThrough())
   );
}

describe('withHydraniumLspFeatures', () => {
   it('suppresses an unhandled rejection from a disposed peer', async () => {
      const sendNotification = vi.fn(() => Promise.reject(new Error('Connection is disposed.')));

      await captureUnhandledRejections(async unhandled => {
         makeConsole(sendNotification).info('late log message');
         await tick();

         expect(unhandled).toEqual([]);
         expect(sendNotification).toHaveBeenCalledWith(LogMessageNotification.type, {
            type: MessageType.Info,
            message: 'late log message'
         });
      });
   });

   it('keeps unexpected log failures visible as unhandled rejections', async () => {
      const failure = new Error('unexpected log failure');
      const sendNotification = vi.fn(() => Promise.reject(failure));

      await captureUnhandledRejections(async unhandled => {
         makeConsole(sendNotification).warn('late log message');
         await tick();

         expect(unhandled).toContain(failure);
      });
   });

   it('composes with the upstream RemoteConsole on a real connection', async () => {
      const connection = makeRealConnection();

      await captureUnhandledRejections(async unhandled => {
         connection.dispose();
         connection.console.info('late log message');
         await tick();

         expect(unhandled).toEqual([]);
      });
   });
});
