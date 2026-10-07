/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractSocketForwardingConnectionHandler } from '@hydranium/client-theia/node';
import { DATA_SERVER_PATH, DATA_SERVER_PORT_COMMAND } from '@hydranium/protocol';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import type * as net from 'node:net';

/** Options for {@link DataServerConnectionHandler}. `servicePath` is the Theia
 *  service path the browser frontend opens a channel to; `portCommand` is the
 *  command id whose return value is the data-server's listening port (the
 *  data-server publishes it on the LSP connection at startup, the same handshake
 *  GLSP uses). */
export interface DataServerConnectionHandlerOptions {
   /** Theia service path the browser frontend opens a channel to. Defaults to
    *  the framework `DATA_SERVER_PATH`; override for an adopter-specific path,
    *  and NECESSARILY when a second frontend reaches the same head — Theia
    *  refuses a second channel on a path already open, so paths are per
    *  FRONTEND while `portCommand` stays per server. */
   readonly servicePath?: string;
   /** Command id whose return value is the data-server's listening port.
    *  Defaults to the framework `DATA_SERVER_PORT_COMMAND`; override to match
    *  an adopter's established id. */
   readonly portCommand?: string;
   /** Name of the server in this handler's log lines. */
   readonly serverName?: string;
   readonly findPortTimeout?: number;
   readonly findPortAttempts?: number;
   readonly connectTimeoutMs?: number;
   /**
    * Optional diagnostic hook called immediately after the outbound
    * `net.Socket` to the data-server is created, BEFORE `socket.connect()` is
    * invoked. Adopters attach `'data'` / `'close'` listeners here for
    * byte-level observability when debugging wire-level issues; attaching
    * before `connect()` guarantees the very first bytes are observed.
    */
   readonly onSocketCreated?: (socket: net.Socket) => void;
}

/**
 * Bridges a Theia browser-frontend channel to a data-server's TCP socket — the
 * backend half of the data-server head's transport.
 *
 * The port discovery, the buffer-and-replay race fix, the connect orchestration
 * and the byte forwarder live on the cross-head
 * {@link AbstractSocketForwardingConnectionHandler} base; this subclass supplies
 * only the data-server defaults (service path / port command / log labels).
 */
@injectable()
export class DataServerConnectionHandler extends AbstractSocketForwardingConnectionHandler {
   constructor(@unmanaged() options: DataServerConnectionHandlerOptions = {}) {
      super({
         path: options.servicePath ?? DATA_SERVER_PATH,
         portCommand: options.portCommand ?? DATA_SERVER_PORT_COMMAND,
         logComponent: 'DataServer',
         serverName: options.serverName ?? 'Data Server',
         findPortTimeout: options.findPortTimeout,
         findPortAttempts: options.findPortAttempts,
         connectTimeoutMs: options.connectTimeoutMs,
         onSocketCreated: options.onSocketCreated
      });
   }

   /** Logged only: the frontend port reports the connection, and a second
    *  notification would duplicate it. */
   protected override reportConnectFailure(): void {}
}
