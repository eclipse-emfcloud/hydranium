/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { HydraniumGlspClient } from '../../src/browser/glsp-client';

const params = { clientSessionId: 'test_0' };

describe('HydraniumGlspClient', () => {
   /** A diagram disposed after its client was lost ends its session; upstream
    *  throws "not ready" there, which the teardown logs as an error. */
   it('ends a session without the server once the connection is gone', async () => {
      const client = new HydraniumGlspClient({ id: 'test', connectionProvider: {} as never });

      await expect(client.disposeClientSession(params)).resolves.toBeUndefined();
   });

   it('still asks a connected server to end the session', async () => {
      const client = new HydraniumGlspClient({ id: 'test', connectionProvider: {} as never });
      const sendRequest = vi.fn(async () => undefined);
      Object.assign(client, { isConnectionActive: () => true, resolvedConnection: { sendRequest } });

      await client.disposeClientSession(params);

      expect(sendRequest).toHaveBeenCalledWith(expect.anything(), params);
   });
});
