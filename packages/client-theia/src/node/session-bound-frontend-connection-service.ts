/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { BackendApplicationConfigProvider } from '@theia/core/lib/node/backend-application-config-provider';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import { WebsocketFrontendConnectionService } from '@theia/core/lib/node/messaging/websocket-frontend-connection-service';
import { injectable, type interfaces } from '@theia/core/shared/inversify';
import { type ConnectionResilienceOptions } from '../common/connection-resilience-options';
import {
   CONNECTION_LOG_PREFIX as PREFIX,
   createFramedSocketWriteBuffer,
   supportsConnectionResilience,
   warnConnectionResilienceUnavailable
} from '../common/framed-socket-write-buffer';

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

   protected override closeConnection(frontEndId: string, reason: string): void {
      console.info(`${PREFIX} closing frontend ${frontEndId}: ${reason}`);
      this.bindings.delete(frontEndId);
      this.offlineSince.delete(frontEndId);
      super.closeConnection(frontEndId, reason);
   }

   /** Mirrors Theia's private `frontendConnectionTimeout`, including `Number('')` resolving to 0. */
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
   rebind(SocketWriteBuffer).toDynamicValue(() => createFramedSocketWriteBuffer(options.bufferBytes));
   return true;
}
