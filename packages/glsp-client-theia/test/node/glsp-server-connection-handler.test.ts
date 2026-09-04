/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { type Channel, type CommandService, type ILogger, type MessageService } from '@theia/core';
import { GlspServerConnectionHandler } from '../../src/node/glsp-server-connection-handler';

/** Backend `ILogger` stub — the handler logs connect/error lines through it. */
function stubLogger(): ILogger {
   return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;
}

class TestHandler extends GlspServerConnectionHandler {
   constructor(options: ConstructorParameters<typeof GlspServerConnectionHandler>[0]) {
      super(options);
   }
   exposeFindPort(): Promise<number> {
      return this.findPort();
   }
   exposeInitialize(channel: Channel): Promise<void> {
      return this.initializeServerConnection(channel);
   }
}

describe('GlspServerConnectionHandler', () => {
   it('composes path from servicePath + language contribution id', () => {
      const handler = new TestHandler({ languageContributionId: 'foo', portCommand: 'foo/glsp/port' });
      // GLSPContribution.servicePath is the upstream constant; we don't need to know its value here,
      // we just verify the contribution id is appended after a slash.
      expect(handler.path.endsWith('/foo')).toBe(true);
   });

   it('findPort resolves with the port returned by the command service', async () => {
      const handler = new TestHandler({
         languageContributionId: 'foo',
         portCommand: 'foo/port',
         findPortTimeout: 0
      });
      handler['commandService'] = {
         executeCommand: vi.fn<() => Promise<number>>().mockResolvedValue(5007)
      } as unknown as CommandService;
      handler['messageService'] = {} as MessageService;
      await expect(handler.exposeFindPort()).resolves.toBe(5007);
   });

   it('findPort retries while the command service throws and resolves once it succeeds', async () => {
      let attempts = 0;
      const handler = new TestHandler({
         languageContributionId: 'foo',
         portCommand: 'foo/port',
         findPortTimeout: 0
      });
      handler['commandService'] = {
         executeCommand: vi.fn().mockImplementation(async () => {
            attempts++;
            if (attempts < 3) {
               throw new Error('not yet');
            }
            return 5008;
         })
      } as unknown as CommandService;
      handler['messageService'] = {} as MessageService;
      await expect(handler.exposeFindPort()).resolves.toBe(5008);
      expect(attempts).toBe(3);
   });

   it('findPort rejects once it has exhausted findPortAttempts', async () => {
      const handler = new TestHandler({
         languageContributionId: 'foo',
         portCommand: 'foo/port',
         findPortTimeout: 0,
         findPortAttempts: 2
      });
      handler['commandService'] = {
         executeCommand: vi.fn<() => Promise<number>>().mockRejectedValue(new Error('port unavailable'))
      } as unknown as CommandService;
      handler['messageService'] = {} as MessageService;
      await expect(handler.exposeFindPort()).rejects.toThrow('port unavailable');
   });

   it('initializeServerConnection surfaces failures via MessageService.error', async () => {
      const handler = new TestHandler({
         languageContributionId: 'foo',
         portCommand: 'foo/port',
         findPortTimeout: 0,
         findPortAttempts: 0
      });
      handler['commandService'] = {
         executeCommand: vi.fn<() => Promise<number>>().mockRejectedValue(new Error('boom'))
      } as unknown as CommandService;
      const errorSpy = vi.fn();
      handler['messageService'] = { error: errorSpy } as unknown as MessageService;
      // `logger` is a readonly injected field, so override it through a cast.
      (handler as unknown as { logger: ILogger }).logger = stubLogger();
      // Don't actually open a socket — pass a stub channel whose `onMessage`
      // returns a no-op disposable; findPort rejects before connectToServer is
      // reached, so the buffer-subscription added by the race-fix never sees
      // any messages.
      const stubChannel = {
         onMessage: vi.fn().mockReturnValue({ dispose: vi.fn() })
      } as unknown as Channel;
      await handler.exposeInitialize(stubChannel);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
   });
});
