/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractSocketForwardingConnectionHandler } from '@hydranium/client-theia/lib/node';
import { DATA_SERVER_PATH, DATA_SERVER_PORT_COMMAND } from '@hydranium/protocol';
import { type Channel, type Disposable } from '@theia/core';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import type * as net from 'node:net';
import { SocketChannelForwarder } from './socket-channel-forwarder';

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
   /**
    * Product name for the connect-failure dialog this handler raises.
    *
    * It reaches the adopter's UI verbatim, so the framework default leaks a
    * framework noun into a product that is not ours. Not a translation concern —
    * routing it through a catalogue would ask an adopter to "translate" English
    * into their own product name, and would make their branding
    * locale-dependent.
    */
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
 * The port-discovery + buffer-and-replay race fix + connect orchestration live
 * on the cross-head {@link AbstractSocketForwardingConnectionHandler} base; this
 * subclass supplies only the data-server defaults (service path / port command /
 * log labels) and plugs in {@link SocketChannelForwarder} as the byte relay —
 * its own forwarder, so the data head carries no GLSP dependency. Sibling of
 * `@hydranium/glsp-client-theia`'s `GlspServerConnectionHandler`, which
 * subclasses the same base with `@eclipse-glsp`'s `SocketConnectionForwarder`.
 */
@injectable()
export class DataServerConnectionHandler extends AbstractSocketForwardingConnectionHandler {
   constructor(@unmanaged() options: DataServerConnectionHandlerOptions = {}) {
      super({
         path: options.servicePath ?? DATA_SERVER_PATH,
         portCommand: options.portCommand ?? DATA_SERVER_PORT_COMMAND,
         logComponent: 'DataServer',
         serverName: options.serverName ?? 'Model Server',
         findPortTimeout: options.findPortTimeout,
         findPortAttempts: options.findPortAttempts,
         connectTimeoutMs: options.connectTimeoutMs,
         onSocketCreated: options.onSocketCreated
      });
   }

   protected forwardToSocketConnection(clientChannel: Channel, socket: net.Socket): Disposable {
      return new SocketChannelForwarder(clientChannel, socket);
   }
}
