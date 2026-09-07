/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Channel,
   CommandService,
   type ConnectionHandler,
   type Disposable,
   ILogger,
   type MessageProvider,
   MessageService
} from '@theia/core';
import { ForwardingChannel } from '@theia/core/lib/common/message-rpc/channel';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as net from 'node:net';

/** Resolved configuration for a {@link AbstractSocketForwardingConnectionHandler}.
 *  A head-specific subclass derives these from its own (adopter-facing) options
 *  and passes them to `super(...)`. */
export interface SocketForwardingConnectionHandlerOptions {
   /** Theia service path the browser frontend opens a channel to. */
   readonly path: string;
   /** Command id whose return value is the target server's listening port (the
    *  server publishes it on the LSP connection at startup). */
   readonly portCommand: string;
   /** Short bracket prefix for this head's diagnostic logs, rendered as
    *  `[<logComponent>] …`. */
   readonly logComponent: string;
   /** Human-readable name of the server this head connects to — used in log and
    *  error messages. */
   readonly serverName: string;
   readonly findPortTimeout?: number;
   readonly findPortAttempts?: number;
   readonly connectTimeoutMs?: number;
   /**
    * Optional diagnostic hook called immediately after the outbound
    * `net.Socket` to the server is created, BEFORE `socket.connect()` is
    * invoked. Adopters attach `'data'` / `'close'` listeners here for
    * byte-level observability when debugging wire-level issues; attaching
    * before `connect()` guarantees the very first bytes are observed.
    */
   readonly onSocketCreated?: (socket: net.Socket) => void;
}

/**
 * Cross-head base for the Theia backend half of a protocol head's transport:
 * it bridges a Theia browser-frontend {@link Channel} to a server's TCP socket
 * by relaying bytes between the two.
 *
 * Theia delivers each frontend connection to a registered `ConnectionHandler`
 * keyed by its `path`. The handler asks the language server (via a registered
 * command) for the target server's listening port, opens a `net.Socket` to that
 * port, and forwards the Theia channel onto the socket. The frontend terminates
 * the same wire protocol the server speaks, so the backend performs no semantic
 * re-proxy — it relays bytes only and stays oblivious to the server's method set.
 *
 * The single per-head variation — *which* byte forwarder bridges the channel and
 * the socket — is the abstract {@link forwardToSocketConnection} hook: the GLSP
 * head plugs in `@eclipse-glsp/theia-integration`'s `SocketConnectionForwarder`,
 * the data-server head its own `SocketChannelForwarder`. Keeping the forwarder
 * behind the hook is what lets the data head stay GLSP-free while sharing the
 * port-discovery + buffer-and-replay race fix + connect orchestration here.
 */
@injectable()
export abstract class AbstractSocketForwardingConnectionHandler implements ConnectionHandler {
   @inject(MessageService) protected messageService!: MessageService;
   @inject(CommandService) protected commandService!: CommandService;
   // Theia backend `ILogger` — this handler runs in the Theia backend process,
   // not the spawned language-server process, so the framework `LspLogger`
   // (which needs the Langium connection/services) is out of reach here.
   @inject(ILogger) protected readonly logger!: ILogger;

   readonly path: string;

   protected readonly portCommand: string;
   protected readonly logComponent: string;
   protected readonly serverName: string;
   protected readonly findPortTimeout: number;
   protected readonly findPortAttempts: number;
   protected readonly connectTimeoutMs: number;
   protected readonly onSocketCreated?: (socket: net.Socket) => void;

   constructor(options: SocketForwardingConnectionHandlerOptions) {
      this.path = options.path;
      this.portCommand = options.portCommand;
      this.logComponent = options.logComponent;
      this.serverName = options.serverName;
      this.findPortTimeout = options.findPortTimeout ?? 500;
      this.findPortAttempts = options.findPortAttempts ?? -1;
      this.connectTimeoutMs = options.connectTimeoutMs ?? 10000;
      this.onSocketCreated = options.onSocketCreated;
   }

   onConnection(connection: Channel): void {
      this.initializeServerConnection(connection);
   }

   protected async initializeServerConnection(channel: Channel): Promise<void> {
      // RACE FIX: subscribe to `channel.onMessage` synchronously and buffer
      // every `MessageProvider` until the forwarder is wired. Theia's
      // `ForwardingChannel.onMessage` is a plain `Emitter` — it does NOT replay
      // to listeners that subscribe later. Without this buffer, frontend writes
      // arriving between `onConnection` and the forwarder subscribing (worst
      // case: the whole `findPort` delay plus the socket connect time) are
      // dropped silently. A frontend builds its proxy synchronously on the
      // channel and may send requests immediately, so it reliably hits this
      // window.
      const buffered: MessageProvider[] = [];
      const bufferSub = channel.onMessage(provider => buffered.push(provider));
      try {
         const port = await this.findPort();
         this.logger.info(`[${this.logComponent}] Connecting to ${this.serverName} on port ${port}...`);
         await this.connectToServer(channel, port, { bufferSub, buffered });
         this.logger.info(`[${this.logComponent}] Connected to ${this.serverName} on port ${port}.`);
      } catch (error) {
         bufferSub.dispose();
         const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
         this.logger.error(`[${this.logComponent}] Could not connect to ${this.serverName}: ${message}`);
         this.messageService.error(`Could not connect to ${this.serverName}: ` + message);
      }
   }

   protected async findPort(): Promise<number> {
      const pendingContent = new Deferred<number>();
      let counter = 0;
      const tryQueryingPort = (): void => {
         setTimeout(async () => {
            try {
               const port = await this.commandService.executeCommand<number>(this.portCommand);
               if (port) {
                  pendingContent.resolve(port);
               }
            } catch (error) {
               counter++;
               if (this.findPortAttempts >= 0 && counter > this.findPortAttempts) {
                  pendingContent.reject(error);
               } else {
                  tryQueryingPort();
               }
            }
         }, this.findPortTimeout);
      };
      tryQueryingPort();
      return pendingContent.promise;
   }

   protected async connectToServer(
      channel: Channel,
      port: number,
      preForwardBuffer?: { bufferSub: Disposable; buffered: MessageProvider[] }
   ): Promise<void> {
      const connected = new Deferred<void>();
      const socket = new net.Socket();
      this.onSocketCreated?.(socket);
      socket.on('ready', () => connected.resolve());
      socket.on('close', () => connected.reject(`Socket to ${this.serverName} was closed.`));
      socket.on('error', error => this.logger.error(`Error occurred with the ${this.serverName} socket: ${error.name}; ${error.message}`));
      // Synchronous hand-off: dispose the pre-forward buffer FIRST, then wire the
      // forwarder, then replay buffered messages. The event loop cannot
      // interleave between these synchronous statements, so no message is both
      // buffered AND forwarded (no double delivery), and none arriving this tick
      // slips through without a subscriber.
      preForwardBuffer?.bufferSub.dispose();
      this.forwardToSocketConnection(channel, socket);
      if (preForwardBuffer && preForwardBuffer.buffered.length > 0) {
         this.replayBufferedMessages(channel, preForwardBuffer.buffered);
      }
      if (channel instanceof ForwardingChannel) {
         socket.on('error', error => channel.onErrorEmitter.fire(error));
      }
      socket.connect({ port });
      setTimeout(() => connected.reject('Timeout reached.'), this.connectTimeoutMs);
      return connected.promise;
   }

   /**
    * Bridge the Theia frontend `clientChannel` and the server `socket` so bytes
    * relay both ways. Called once, after the socket is created and the
    * pre-forward buffer is about to be replayed.
    */
   protected abstract forwardToSocketConnection(clientChannel: Channel, socket: net.Socket): Disposable;

   /**
    * Re-fire pre-forward buffered `MessageProvider`s on the channel's internal
    * `onMessageEmitter` so the now-subscribed forwarder picks them up in arrival
    * order. `MessageProvider` is a thunk (`() => ReadBuffer`) — buffering does
    * not consume the read position, so replay produces the same bytes the
    * forwarder would have seen if wired earlier.
    *
    * `AbstractChannel.onMessageEmitter` is `protected` in `@theia/core` but
    * reachable at runtime; the cast is the workaround. A future Theia rename
    * surfaces as a clear warning here.
    */
   protected replayBufferedMessages(channel: Channel, buffered: MessageProvider[]): void {
      if (!(channel instanceof ForwardingChannel)) {
         this.logger.warn(`[${this.logComponent}] dropping ${buffered.length} pre-forward message(s) — channel is not a ForwardingChannel`);
         return;
      }
      const internals = channel as unknown as { onMessageEmitter?: { fire(provider: MessageProvider): void } };
      if (!internals.onMessageEmitter) {
         this.logger.warn(
            `[${this.logComponent}] dropping ${buffered.length} pre-forward message(s) — ForwardingChannel.onMessageEmitter not accessible`
         );
         return;
      }
      this.logger.info(`[${this.logComponent}] replaying ${buffered.length} pre-forward message(s) onto the wired socket forwarder`);
      for (const provider of buffered) {
         internals.onMessageEmitter.fire(provider);
      }
   }
}
