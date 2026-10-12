/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferElement } from '@hydranium/protocol';
import type { DataServerProtocol } from '@hydranium/protocol/data';

/**
 * Run `fn` as the client session `clientId`, and end the session whether `fn`
 * succeeded or not, which closes whatever it left open. An end that fails
 * after a failed `fn` is swallowed: `fn`'s error is the one the user needs.
 */
export async function withClientSession<T>(
   server: Pick<DataServerProtocol<TransferElement>, 'createSession' | 'closeSession'>,
   clientId: string,
   fn: () => Promise<T>
): Promise<T> {
   await server.createSession({ clientId, label: 'hydranium-cli' });
   let result: T;
   try {
      result = await fn();
   } catch (error: unknown) {
      await server.closeSession({ clientId }).catch(() => undefined);
      throw error;
   }
   await server.closeSession({ clientId });
   return result;
}
