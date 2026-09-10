/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GLSPContribution } from '@eclipse-glsp/theia-integration/lib/common';
import { SocketConnectionForwarder } from '@eclipse-glsp/theia-integration/lib/node';
import { AbstractSocketForwardingConnectionHandler } from '@hydranium/client-theia/lib/node';
import { type Channel, type Disposable } from '@theia/core';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import type * as net from 'net';

/** Options for `GlspServerConnectionHandler`. The language contribution
 *  id determines the per-language servicePath that Theia routes browser-frontend
 *  connections to; the port command is the Theia/VS Code command id whose return
 *  value is the GLSP server's listening port. */
export interface GlspServerConnectionHandlerOptions {
   readonly languageContributionId: string;
   readonly portCommand: string;
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
    * `net.Socket` to the GLSP server is created, BEFORE `socket.connect()`
    * is invoked. Adopters use this to attach `'data'` / `'close'` listeners
    * for byte-level observability when debugging wire-level handshake
    * issues; attaching listeners before `connect()` is what guarantees the
    * very first bytes are observed.
    */
   readonly onSocketCreated?: (socket: net.Socket) => void;
}

/**
 * Bridges a Theia browser-frontend channel to a GLSP server's TCP socket.
 *
 * The port-discovery + buffer-and-replay race fix + connect orchestration live
 * on the cross-head {@link AbstractSocketForwardingConnectionHandler} base; this
 * subclass supplies only the GLSP specifics — the per-language servicePath
 * (`GLSPContribution.servicePath + '/' + languageContributionId`), the port
 * command, the log labels — and plugs in `@eclipse-glsp/theia-integration`'s
 * `SocketConnectionForwarder` as the byte relay. Adopters with different
 * language ids or command names subclass with a one-line `super({...})` call.
 * Sibling of `@hydranium/data-client-theia`'s `DataServerConnectionHandler`,
 * which subclasses the same base with its own GLSP-free forwarder.
 */
@injectable()
export class GlspServerConnectionHandler extends AbstractSocketForwardingConnectionHandler {
   constructor(@unmanaged() options: GlspServerConnectionHandlerOptions) {
      super({
         path: GLSPContribution.servicePath + '/' + options.languageContributionId,
         portCommand: options.portCommand,
         logComponent: 'GLSP',
         serverName: options.serverName ?? 'Graphical Server',
         findPortTimeout: options.findPortTimeout,
         findPortAttempts: options.findPortAttempts,
         connectTimeoutMs: options.connectTimeoutMs,
         onSocketCreated: options.onSocketCreated
      });
   }

   protected forwardToSocketConnection(clientChannel: Channel, socket: net.Socket): Disposable {
      return new SocketConnectionForwarder(clientChannel, socket);
   }
}
