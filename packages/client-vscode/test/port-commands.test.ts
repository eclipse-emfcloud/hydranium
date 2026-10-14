/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { registerPortCommands } from '../src/node/port-commands';

// `vscode` exists only inside the extension host, so the registry is a double
// that records each handler under its command id.
const registered = vi.hoisted(() => new Map<string, () => unknown>());
vi.mock('vscode', () => ({
   commands: {
      registerCommand: (commandId: string, handler: () => unknown) => {
         registered.set(commandId, handler);
         return { dispose: () => registered.delete(commandId) };
      }
   }
}));

describe('registerPortCommands', () => {
   it('answers each command with the port its request returns', async () => {
      const subscriptions: Array<{ dispose(): unknown }> = [];
      const client = { sendRequest: <R>(method: string) => Promise.resolve((method === 'a/data/port' ? 1001 : 1002) as R) };

      registerPortCommands({ subscriptions }, client, { 'a.port.data': 'a/data/port', 'a.port.glsp': 'a/glsp/port' });

      await expect(registered.get('a.port.data')?.()).resolves.toBe(1001);
      await expect(registered.get('a.port.glsp')?.()).resolves.toBe(1002);
   });

   it('releases every command with the extension', () => {
      const subscriptions: Array<{ dispose(): unknown }> = [];
      const client = { sendRequest: <R>() => Promise.resolve(1 as R) };

      registerPortCommands({ subscriptions }, client, { 'a.port.data': 'a/data/port' });
      subscriptions.forEach(subscription => subscription.dispose());

      expect(registered.has('a.port.data')).toBe(false);
   });
});
