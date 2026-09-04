/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { PassThrough } from 'node:stream';

/**
 * A crossed pair of in-process `PassThrough` streams modelling one
 * bidirectional client/server transport. Each `PassThrough` is itself both
 * readable and writable: the side named first writes, the side named second
 * reads off the same object. The shared substrate under the framework's
 * in-process test transports — `makeDuplexConnectionPair` layers a
 * `MessageConnection` pair on top.
 */
export interface DuplexStreamPair {
   /** Client writes here; server reads here. */
   readonly clientToServer: PassThrough;
   /** Server writes here; client reads here. */
   readonly serverToClient: PassThrough;
   /** Destroy both streams. Idempotent. */
   dispose(): void;
}

/**
 * Build a fresh {@link DuplexStreamPair}. The two streams are independent;
 * data written to one never appears on the other. Call `dispose` at test
 * teardown to release them.
 */
export function makeDuplexStreamPair(): DuplexStreamPair {
   const clientToServer = new PassThrough();
   const serverToClient = new PassThrough();

   let disposed = false;
   return {
      clientToServer,
      serverToClient,
      dispose(): void {
         if (disposed) {
            return;
         }
         disposed = true;
         clientToServer.destroy();
         serverToClient.destroy();
      }
   };
}
