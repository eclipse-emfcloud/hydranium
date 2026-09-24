/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '@hydranium/protocol/testing';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { Connection } from 'vscode-languageserver';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { withHydraniumLspFeatures } from '../../src/lsp/connection-features.js';
import { guardDiagnosticsConnection } from '../../src/lsp/diagnostics-connection.js';
import { captureUnhandledRejections } from '../../src/testing/node/unhandled-rejections.js';

function makeConnection(sendDiagnostics: Connection['sendDiagnostics']): Connection {
   return { sendDiagnostics } as unknown as Connection;
}

/**
 * A real connection with the features every server entry point supplies. Real
 * rather than stubbed because a failed send is logged through the same
 * connection's console, and only a real connection shows that second write
 * failing too.
 */
function makeRealConnection(): { connection: Connection; output: PassThrough } {
   const output = new PassThrough();
   const connection = createConnection(
      withHydraniumLspFeatures(ProposedFeatures.all),
      new StreamMessageReader(new PassThrough()),
      new StreamMessageWriter(output)
   );
   guardDiagnosticsConnection(connection);
   return { connection, output };
}

describe('guardDiagnosticsConnection', () => {
   it('suppresses a diagnostics rejection caused by a disposed peer', async () => {
      const sendDiagnostics = vi.fn(() => Promise.reject(new Error('Connection is disposed.')));
      const connection = makeConnection(sendDiagnostics);

      await captureUnhandledRejections(async unhandled => {
         guardDiagnosticsConnection(connection);
         void connection.sendDiagnostics({} as never);
         await tick();

         expect(unhandled).toEqual([]);
         expect(sendDiagnostics).toHaveBeenCalledOnce();
      });
   });

   it('keeps unexpected diagnostics failures visible as unhandled rejections', async () => {
      const failure = new Error('unexpected diagnostics failure');
      const connection = makeConnection(vi.fn(() => Promise.reject(failure)));

      await captureUnhandledRejections(async unhandled => {
         guardDiagnosticsConnection(connection);
         void connection.sendDiagnostics({} as never);
         await tick();

         expect(unhandled).toContain(failure);
      });
   });

   it('answers a synchronous disposed-connection throw with a resolved promise', async () => {
      const connection = makeConnection(
         vi.fn(() => {
            throw new Error('Connection is disposed.');
         })
      );

      guardDiagnosticsConnection(connection);

      await expect(connection.sendDiagnostics({} as never)).resolves.toBeUndefined();
   });

   it('rethrows an unexpected synchronous failure', () => {
      const failure = new Error('unexpected diagnostics failure');
      const connection = makeConnection(
         vi.fn(() => {
            throw failure;
         })
      );

      guardDiagnosticsConnection(connection);

      expect(() => connection.sendDiagnostics({} as never)).toThrow(failure);
   });

   it('survives a publish issued after a real connection is disposed', async () => {
      const { connection } = makeRealConnection();

      await captureUnhandledRejections(async unhandled => {
         connection.dispose();
         await connection.sendDiagnostics({ uri: 'file:///a.x', diagnostics: [] });
         await tick();

         expect(unhandled).toEqual([]);
      });
   });

   it('survives a publish queued before its transport is destroyed', async () => {
      const { connection, output } = makeRealConnection();

      await captureUnhandledRejections(async unhandled => {
         // The writer encodes asynchronously, so destroying the stream straight
         // after the send lands between the send and its write.
         void connection.sendDiagnostics({ uri: 'file:///a.x', diagnostics: [] });
         output.destroy();
         await tick();

         expect(unhandled).toEqual([]);
      });
   });

   it('does not wrap one connection more than once', async () => {
      const sendDiagnostics = vi.fn(() => Promise.resolve());
      const connection = makeConnection(sendDiagnostics);

      guardDiagnosticsConnection(connection);
      const wrappedSendDiagnostics = connection.sendDiagnostics;
      guardDiagnosticsConnection(connection);

      expect(connection.sendDiagnostics).toBe(wrappedSendDiagnostics);
      await connection.sendDiagnostics({} as never);
      expect(sendDiagnostics).toHaveBeenCalledOnce();
   });
});
