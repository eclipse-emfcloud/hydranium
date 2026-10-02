/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { AbstractChannel } from '@theia/core/lib/common/message-rpc/channel';
import { type WriteBuffer } from '@theia/core/lib/common/message-rpc/message-buffer';
import { Uint8ArrayReadBuffer, Uint8ArrayWriteBuffer } from '@theia/core/lib/common/message-rpc/uint8-array-message-buffer';
import { BackendApplicationConfigProvider } from '@theia/core/lib/node/backend-application-config-provider';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import { WebsocketFrontendConnectionService } from '@theia/core/lib/node/messaging/websocket-frontend-connection-service';
import { injectable, type interfaces } from '@theia/core/shared/inversify';
import { type ConnectionResilienceOptions } from '../common/connection-resilience-options';
import {
   CONNECTION_LOG_PREFIX as PREFIX,
   createFramedSocketWriteBuffer,
   FramedSocketWriteBuffer,
   supportsConnectionResilience,
   warnConnectionResilienceUnavailable
} from '../common/framed-socket-write-buffer';
import { ACKNOWLEDGEMENT_EVENT, InboundMessageSequence } from '../common/inbound-message-sequence';

/**
 * Socket Theia hands the disconnect handler, read off the base signature rather
 * than imported, which spares a direct `socket.io` dependency carried purely
 * for a parameter type.
 */
export type FrontendSocket = Parameters<WebsocketFrontendConnectionService['handleSocketDisconnect']>[0];

/**
 * Channel Theia hands the disconnect handler, read off the base signature so
 * this package's emitted declarations name only
 * `WebsocketFrontendConnectionService`.
 *
 * `ReconnectableSocketChannel` is not exported by every Theia release in the
 * supported range, so importing it would make those declarations unresolvable
 * for an adopter on one of them — a compile error for a feature they may not
 * even be using.
 */
export type FrontendChannel = Parameters<WebsocketFrontendConnectionService['handleSocketDisconnect']>[1];

/**
 * The server end of one frontend's session, carried across the sockets the
 * frontend reconnects on.
 *
 * Theia's own channel sends straight into any socket that reports itself
 * connected. A socket whose far end died unnoticed still does, so whatever is
 * sent until the server notices is lost. This one numbers and keeps every
 * message through {@link FramedSocketWriteBuffer}, resends what is still
 * unacknowledged when the frontend reconnects, and drops what it has received
 * twice. Otherwise it behaves as Theia's.
 */
export class AcknowledgedSocketChannel extends AbstractChannel {
   protected socket: FrontendSocket | undefined;
   protected socketDisposables = new DisposableCollection();
   protected readonly inbound = new InboundMessageSequence(sequence => this.socket?.emit(ACKNOWLEDGEMENT_EVENT, sequence));

   constructor(protected readonly socketBuffer: FramedSocketWriteBuffer) {
      super();
      this.toDispose.push(this.inbound);
      this.toDispose.push(Disposable.create(() => this.socketDisposables.dispose()));
   }

   /** Flushes in the same step that attaches the listeners, so nothing new can overtake the resend. */
   connect(socket: FrontendSocket): void {
      this.socketDisposables.dispose();
      this.socketDisposables = new DisposableCollection();
      this.socket = socket;
      const errorHandler = (error: unknown): void => this.onErrorEmitter.fire(error);
      const dataListener = (data: ArrayBuffer | Uint8Array, sequence?: unknown): void => {
         if (typeof sequence === 'number') {
            this.socketBuffer.markPeerDeduplicates();
         }
         if (!this.inbound.accept(sequence, data.byteLength)) {
            return;
         }
         const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
         this.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(buffer));
      };
      const acknowledgementListener = (sequence: unknown): void => {
         if (typeof sequence === 'number') {
            this.socketBuffer.acknowledge(sequence);
         }
      };
      socket.on('error', errorHandler);
      socket.on('message', dataListener);
      socket.on(ACKNOWLEDGEMENT_EVENT, acknowledgementListener);
      this.socketDisposables.push(
         Disposable.create(() => {
            socket.off('error', errorHandler);
            socket.off('message', dataListener);
            socket.off(ACKNOWLEDGEMENT_EVENT, acknowledgementListener);
         })
      );
      this.socketBuffer.flush(socket);
   }

   disconnect(): void {
      this.socketDisposables.dispose();
      this.socket = undefined;
   }

   drainBuffer(): void {
      this.socketBuffer.drain();
   }

   getWriteBuffer(): WriteBuffer {
      const writeBuffer = new Uint8ArrayWriteBuffer();
      writeBuffer.onCommit(data => this.socketBuffer.sendOrQueue(this.socket?.connected ? this.socket : undefined, data));
      return writeBuffer;
   }
}

/**
 * Ignores a disconnect from a socket that no longer belongs to the frontend.
 *
 * A frontend that loses its network reconnects on a new socket within seconds;
 * the server only notices the old one is gone when its next heartbeat write
 * fails, which is a whole ping interval later. For that stretch both sockets are
 * registered against the same session, and Theia's disconnect handler tears the
 * session off its socket without checking which one just died. The late
 * notification from the abandoned socket therefore cuts the healthy one loose.
 * The frontend sees a connected socket and never retries, so the session is dead
 * until the page is reloaded.
 *
 * Changed here: only the socket the session is currently using may act on a
 * disconnect. The handler is rewritten rather than wrapped because the problem
 * sits inside the listener Theia installs; the rest of the body is Theia's.
 *
 * Re-diff against Theia when the supported range moves: `override` catches a changed signature,
 * not a changed body, so this copy can go stale in silence.
 */
@injectable()
export class SessionBoundFrontendConnectionService extends WebsocketFrontendConnectionService {
   /** Socket each frontend's channel is currently bound to, with the time it was bound. */
   protected readonly bindings = new Map<string, { socketId: string; boundAt: number }>();
   /** When a frontend's live socket went away, so the reconnect gap can be reported. */
   protected readonly offlineSince = new Map<string, number>();

   override handleSocketDisconnect(socket: FrontendSocket, channel: FrontendChannel, frontEndId: string): void {
      const previous = this.bindings.get(frontEndId);
      this.bindings.set(frontEndId, { socketId: socket.id, boundAt: Date.now() });

      const wentOfflineAt = this.offlineSince.get(frontEndId);
      this.offlineSince.delete(frontEndId);
      const replacing = previous ? `, replacing socket ${previous.socketId}` : '';
      const gap = wentOfflineAt === undefined ? '' : `, after ${Date.now() - wentOfflineAt} ms offline`;
      console.info(`${PREFIX} frontend ${frontEndId} channel bound to socket ${socket.id}${replacing}${gap}`);

      socket.on('disconnect', reason => {
         const bound = this.bindings.get(frontEndId);
         if (bound?.socketId !== socket.id) {
            // Either a superseded socket being reaped late, or one outliving `closeConnection`, which
            // deletes the binding. Neither owns the channel, so neither may disconnect it, arm a close
            // timeout, or close a connection that is no longer in `connectionsByFrontend`.
            const owner = bound
               ? `socket ${bound.socketId} owns it (bound ${Date.now() - bound.boundAt} ms ago)`
               : 'the connection is already closed';
            console.info(`${PREFIX} ignoring disconnect of stale socket ${socket.id} (frontend ${frontEndId}, ${reason}); ${owner}`);
            return;
         }

         // From here on: Theia's own handler body, unchanged apart from naming the socket.
         this.offlineSince.set(frontEndId, Date.now());
         console.info(`${PREFIX} socket ${socket.id} (frontend ${frontEndId}) disconnected: ${reason}`);
         channel.disconnect();
         const timeout = this.connectionTimeout();
         const isMarkedForClose = this.channelsMarkedForClose.delete(frontEndId);
         if (timeout === 0 || isMarkedForClose) {
            this.closeConnection(frontEndId, reason);
         } else if (timeout > 0) {
            console.info(`${PREFIX} close timeout for frontend ${frontEndId} set to ${timeout} ms`);
            this.closeTimeouts.set(
               frontEndId,
               setTimeout(() => this.closeConnection(frontEndId, reason), timeout)
            );
         }
         // timeout < 0: never close the back end.
      });
   }

   /**
    * Theia's body, building an {@link AcknowledgedSocketChannel} in place of its own channel.
    *
    * Handed over through a cast, because Theia types the slot as its own channel class. The cast
    * also hides from the compiler what Theia calls on the channel, so a release that calls a member
    * this one lacks fails at runtime: re-diff with the disconnect handler.
    */
   protected override createConnection(socket: FrontendSocket, frontEndId: string): FrontendChannel {
      const channel = new AcknowledgedSocketChannel(this.createWriteBuffer()) as unknown as FrontendChannel;
      channel.connect(socket);
      this.connectionsByFrontend.set(frontEndId, channel);
      return channel;
   }

   /**
    * One buffer per session, from the container Theia resolves its own channel's buffer from.
    * Reached through a structural view because Theia 1.70 does not declare `container`.
    */
   protected createWriteBuffer(): FramedSocketWriteBuffer {
      const container = (this as unknown as { readonly container: interfaces.Container }).container;
      const buffer = container.get<SocketWriteBuffer>(SocketWriteBuffer);
      if (!(buffer instanceof FramedSocketWriteBuffer)) {
         throw new Error('SessionBoundFrontendConnectionService requires FramedSocketWriteBuffer to be bound');
      }
      return buffer;
   }

   protected override closeConnection(frontEndId: string, reason: string): void {
      console.info(`${PREFIX} closing frontend ${frontEndId}: ${reason}`);
      this.bindings.delete(frontEndId);
      this.offlineSince.delete(frontEndId);
      super.closeConnection(frontEndId, reason);
   }

   /** Mirrors Theia's private `frontendConnectionTimeout`, including `Number('')` resolving to 0.
    *  Private there, so the copy is forced; re-diff it with the handler above. */
   protected connectionTimeout(): number {
      const envValue = Number(process.env['FRONTEND_CONNECTION_TIMEOUT']);
      if (!isNaN(envValue)) {
         return envValue;
      }
      return BackendApplicationConfigProvider.get().frontendConnectionTimeout;
   }
}

/**
 * Replaces the server pieces that decide how a session survives a reconnect.
 *
 * `FrontendConnectionService` is bound `toService(WebsocketFrontendConnectionService)`,
 * so rebinding the concrete class is enough. The buffer stays transient (one per
 * connection), matching Theia's `bind(SocketWriteBuffer).toSelf()`; the frontend
 * counterpart is bound by `bindConnectionResilience` in a `frontendPreload`
 * module, which is the only point early enough on that side.
 *
 * Does nothing but warn on a Theia too old to expose the buffer binding, so the
 * package keeps one supported range rather than splitting its floor for this
 * feature. Returns whether the hardening was installed, for an adopter that
 * wants to branch on it.
 */
export function bindConnectionResilience(
   bind: interfaces.Bind,
   isBound: interfaces.IsBound,
   rebind: interfaces.Rebind,
   options: ConnectionResilienceOptions = {}
): boolean {
   if (!supportsConnectionResilience(isBound)) {
      warnConnectionResilienceUnavailable('backend');
      return false;
   }
   bind(SessionBoundFrontendConnectionService).toSelf().inSingletonScope();
   rebind(WebsocketFrontendConnectionService).toService(SessionBoundFrontendConnectionService);
   rebind(SocketWriteBuffer).toDynamicValue(() => createFramedSocketWriteBuffer(options));
   return true;
}
