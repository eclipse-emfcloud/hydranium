/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
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
}

describe('DataServerConnectionHandler', () => {
   it('defaults servicePath and portCommand to the framework data-server constants', () => {
      const handler = new TestHandler();
      expect(handler.path).toBe(DATA_SERVER_PATH);
      expect(handler.resolvedPortCommand).toBe(DATA_SERVER_PORT_COMMAND);
   });

   it('uses explicit servicePath and portCommand when provided', () => {
      const handler = new TestHandler({ servicePath: '/services/custom', portCommand: 'custom:port' });
      expect(handler.path).toBe('/services/custom');
      expect(handler.resolvedPortCommand).toBe('custom:port');
   });
});
