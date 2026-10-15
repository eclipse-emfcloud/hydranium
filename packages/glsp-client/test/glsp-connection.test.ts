/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { JsonrpcGLSPClient } from '@eclipse-glsp/client';
import { describe, expect, it, vi } from 'vitest';
import { glspConnection } from '../src/glsp-connection';

describe('glspConnection', () => {
   it("sends GLSP's own typed messages by their method name", async () => {
      const sendNotification = vi.fn(async () => undefined);
      const connection = glspConnection({ sendRequest: vi.fn(), sendNotification });

      await connection.sendNotification(JsonrpcGLSPClient.ShutdownNotification);

      expect(sendNotification).toHaveBeenCalledWith(JsonrpcGLSPClient.ShutdownNotification.method);
   });
});
