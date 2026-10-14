/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page's LSP handshake against a server-shaped far end over a port pair,
 * headless: what reaches the server, and what the page answers when the
 * server asks.
 */

import { createMessagePortTransport, NoopLogger } from '@hydranium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';
import {
   ConfigurationRequest,
   InitializedNotification,
   InitializeRequest,
   LogMessageNotification,
   MessageType,
   RegistrationRequest,
   type InitializeParams,
   type InitializeResult
} from 'vscode-languageserver-protocol';
import { initializeLanguageClient, type LanguageClientOptions } from '../src';
import { anotherCopyConnection } from './another-copy-connection.js';

const toDispose: { dispose(): void }[] = [];

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
});

const SERVER_ANSWER: InitializeResult = { capabilities: { hoverProvider: true } };

/** The page's connection and the server's, over one port pair; the server already listens and answers `initialize`. */
function makeEnds(): { page: MessageConnection; server: MessageConnection; initializeParams: InitializeParams[] } {
   const channel = new MessageChannel();
   const pageTransport = createMessagePortTransport(channel.port1);
   const serverTransport = createMessagePortTransport(channel.port2);
   const page = createMessageConnection(pageTransport.reader, pageTransport.writer, new NoopLogger());
   const server = createMessageConnection(serverTransport.reader, serverTransport.writer, new NoopLogger());
   toDispose.push(page, server);
   const initializeParams: InitializeParams[] = [];
   server.onRequest(InitializeRequest.type, params => {
      initializeParams.push(params);
      return SERVER_ANSWER;
   });
   server.listen();
   return { page, server, initializeParams };
}

const OPTIONS: LanguageClientOptions = { rootUri: 'file:///workspace', locale: 'de' };

describe('initializeLanguageClient', () => {
   it('sends initialize with the root, its folder, the locale and the two capabilities, then initialized', async () => {
      const { page, server, initializeParams } = makeEnds();
      let initialized = 0;
      server.onNotification(InitializedNotification.type, () => {
         initialized++;
      });

      await expect(initializeLanguageClient(page, OPTIONS)).resolves.toEqual(SERVER_ANSWER);

      expect(initializeParams).toHaveLength(1);
      expect(initializeParams[0]).toMatchObject({
         rootUri: 'file:///workspace',
         locale: 'de',
         capabilities: { workspace: { applyEdit: true, configuration: true } },
         workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }]
      });
      // `initialized` is a notification, so it is awaited by asking the server
      // a question it answers after it.
      await server.sendRequest('server/flush').catch(() => undefined);
      expect(initialized).toBe(1);
   });

   it('completes over a connection of another vscode-jsonrpc copy, sending by method name', async () => {
      const { page, server, initializeParams } = makeEnds();
      let initialized = 0;
      server.onNotification(InitializedNotification.type, () => {
         initialized++;
      });

      await expect(initializeLanguageClient(anotherCopyConnection(page), OPTIONS)).resolves.toEqual(SERVER_ANSWER);

      expect(initializeParams).toHaveLength(1);
      await server.sendRequest('server/flush').catch(() => undefined);
      expect(initialized).toBe(1);
   });

   it('names the folder after the root itself when the root has no path segment', async () => {
      const { page, initializeParams } = makeEnds();

      await initializeLanguageClient(page, { rootUri: 'file:///' });

      expect(initializeParams[0].workspaceFolders).toEqual([{ uri: 'file:///', name: 'file:///' }]);
   });

   it('decodes the folder name, so a percent-encoded segment reads as its text', async () => {
      const { page, initializeParams } = makeEnds();

      await initializeLanguageClient(page, { rootUri: 'file:///my%20project' });

      expect(initializeParams[0].workspaceFolders).toEqual([{ uri: 'file:///my%20project', name: 'my project' }]);
   });

   it('rejects a root that is no URL before the connection listens, so the host can still use it', async () => {
      const { page } = makeEnds();

      await expect(initializeLanguageClient(page, { rootUri: 'not a uri' })).rejects.toThrow();

      // A connection that listens already throws here.
      expect(() => page.listen()).not.toThrow();
   });

   it('answers a configuration request item by item, the named section with the settings and any other with null', async () => {
      const { page, server } = makeEnds();
      await initializeLanguageClient(page, {
         ...OPTIONS,
         configuration: { section: 'mine', settings: () => ({ log: { level: 'debug' } }) }
      });

      const answer = await server.sendRequest(ConfigurationRequest.type, { items: [{ section: 'other' }, { section: 'mine' }] });

      expect(answer).toEqual([null, { log: { level: 'debug' } }]);
   });

   it('acknowledges a capability registration rather than failing it as an unknown method', async () => {
      const { page, server } = makeEnds();
      await initializeLanguageClient(page, OPTIONS);

      await expect(server.sendRequest(RegistrationRequest.type, { registrations: [] })).resolves.toBeNull();
   });

   it('calls beforeInitialized with the answer, before initialized goes out', async () => {
      const { page, server } = makeEnds();
      // Observed at the SERVER, as the order the two messages arrive in: a
      // local record would place the hook before any arrival whichever was
      // sent first.
      const arrived: string[] = [];
      server.onNotification(InitializedNotification.type, () => {
         arrived.push('initialized');
      });
      server.onNotification('client/before', (capability: unknown) => {
         arrived.push(`before:${String(capability)}`);
      });

      await initializeLanguageClient(page, {
         ...OPTIONS,
         beforeInitialized: result => void page.sendNotification('client/before', result.capabilities.hoverProvider)
      });

      await server.sendRequest('server/flush').catch(() => undefined);
      expect(arrived).toEqual(['before:true', 'initialized']);
   });

   it('hands the host a log message the server sends while initializing', async () => {
      const { page, server } = makeEnds();
      server.onRequest(InitializeRequest.type, () => {
         void server.sendNotification(LogMessageNotification.type, { type: MessageType.Info, message: 'walking the workspace' });
         return SERVER_ANSWER;
      });
      const logged: string[] = [];

      await initializeLanguageClient(page, { ...OPTIONS, onLogMessage: params => logged.push(params.message) });

      expect(logged).toEqual(['walking the workspace']);
   });
});
