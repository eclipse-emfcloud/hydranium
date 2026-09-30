/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { type Channel, type CommandService, type ILogger, type MessageService } from '@theia/core';
import { DATA_SERVER_PATH, DATA_SERVER_PORT_COMMAND } from '@hydranium/protocol';
import { DataServerConnectionHandler, type DataServerConnectionHandlerOptions } from '../src/node/data-server-connection-handler';

/** Subclass exposing the protected `portCommand` the base resolved. The
 *  constructor only reads `options`; the `@inject`ed `MessageService` /
 *  `CommandService` fields stay unset (the defaulting behaviour under test
 *  doesn't touch them). */
class TestHandler extends DataServerConnectionHandler {
   constructor(options: DataServerConnectionHandlerOptions = {}) {
      super(options);
   }
   get resolvedPortCommand(): string {
      return this.portCommand;
   }
   get resolvedServerName(): string {
      return this.serverName;
   }
   initialize(channel: Channel): Promise<void> {
      return this.initializeServerConnection(channel);
   }
}

describe('DataServerConnectionHandler', () => {
   it('defaults servicePath and portCommand to the framework data-server constants', () => {
      const handler = new TestHandler();
      expect(handler.path).toBe(DATA_SERVER_PATH);
      expect(handler.resolvedPortCommand).toBe(DATA_SERVER_PORT_COMMAND);
   });

   it('names its server "Data Server" in its logs by default', () => {
      expect(new TestHandler().resolvedServerName).toBe('Data Server');
   });

   /** The frontend port reports the connection; a toast here would be a second
    *  notification for it. */
   it('logs a failed connection without a notification', async () => {
      const handler = new TestHandler({ findPortTimeout: 0, findPortAttempts: 0 });
      const error = vi.fn();
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;
      Object.assign(handler, {
         logger,
         messageService: { error } as unknown as MessageService,
         commandService: { executeCommand: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as CommandService
      });
      const channel = {
         onMessage: () => ({ dispose: () => undefined }),
         onClose: () => ({ dispose: () => undefined }),
         close: vi.fn()
      } as unknown as Channel;

      await handler.initialize(channel);

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
      expect(error).not.toHaveBeenCalled();
   });

   it('uses explicit servicePath and portCommand when provided', () => {
      const handler = new TestHandler({ servicePath: '/services/custom', portCommand: 'custom:port' });
      expect(handler.path).toBe('/services/custom');
      expect(handler.resolvedPortCommand).toBe('custom:port');
   });
});
