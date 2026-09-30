/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { BaseJsonrpcGLSPClient, type DisposeClientSessionParameters } from '@eclipse-glsp/client';

/** The GLSP client of `HydraniumGlspClientContribution`. */
export class HydraniumGlspClient extends BaseJsonrpcGLSPClient {
   /** Resolves at once when the connection is gone: the session went with its
    *  server, and upstream would throw, which a diagram disposed after its
    *  client was lost logs as an error. */
   override disposeClientSession(params: DisposeClientSessionParameters): Promise<void> {
      return this.isConnectionActive() ? super.disposeClientSession(params) : Promise.resolve();
   }
}
