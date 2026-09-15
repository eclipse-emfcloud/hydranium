/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MessageService, nls } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ConnectionStatus, ConnectionStatusService } from '@theia/core/lib/browser/connection-status-service';
import { WebSocketConnectionSource } from '@theia/core/lib/browser/messaging/ws-connection-source';
import { inject, injectable, type interfaces } from '@theia/core/shared/inversify';
import { type ConnectionBufferOverflow } from '../common/framed-socket-write-buffer';
import { ChannelLogger } from './channel-logger';
import { SessionAwareConnectionSource } from './session-aware-connection-source';

/**
 * Records the browser side of the websocket lifecycle into the adopter's Output
 * channel, and tells the user the one thing they cannot recover from on their
 * own.
 *
 * Theia reports an outage only as an "Offline" status-bar item, which cannot
 * distinguish a plain network drop from the server having stopped answering on a
 * socket that is still up. The latter is what a connection defect looks like
 * from here, so the two are logged differently — that distinction is what says
 * whether reopening an editor helps or only a reload does.
 *
 * Purely observational apart from the overflow message: nothing here changes how
 * the connection behaves.
 */
@injectable()
export class ConnectionDiagnosticsContribution implements FrontendApplicationContribution {
   @inject(WebSocketConnectionSource) protected readonly connectionSource: WebSocketConnectionSource;
   @inject(ConnectionStatusService) protected readonly connectionStatus: ConnectionStatusService;
   @inject(ChannelLogger) protected readonly logger: ChannelLogger;
   @inject(MessageService) protected readonly messageService: MessageService;

   /** Main channels created so far; more than one means the server did not recognise this frontend. */
   protected channelCount = 0;
   protected socketClosedAt?: number;
   protected offlineAt?: number;

   initialize(): void {
      this.connectionSource.onSocketDidOpen(() => this.handleSocketOpen());
      this.connectionSource.onSocketDidClose(() => this.handleSocketClose());
      this.connectionSource.onConnectionDidOpen(() => this.handleChannelOpen());
      this.connectionStatus.onStatusChange(status => this.handleStatusChange(status));
      if (this.connectionSource instanceof SessionAwareConnectionSource) {
         this.connectionSource.onBufferOverflow(overflow => this.handleBufferOverflow(overflow));
      }
      // The socket is opened by the preloader, before this contribution exists, so the first
      // `onSocketDidOpen` has already fired; state the current situation instead.
      this.logger.info(`diagnostics active; socket ${this.socketId()}, backend ${this.statusName(this.connectionStatus.currentStatus)}`);
   }

   protected handleSocketOpen(): void {
      const downFor = this.socketClosedAt === undefined ? '' : ` after ${Date.now() - this.socketClosedAt} ms down`;
      this.socketClosedAt = undefined;
      this.logger.info(`websocket connected: socket ${this.socketId()}${downFor}`);
   }

   protected handleSocketClose(): void {
      this.socketClosedAt = Date.now();
      this.logger.info(`websocket disconnected: socket ${this.socketId()}; outgoing messages are buffered until it returns`);
   }

   /**
    * A second channel means the reconnect was refused and the session discarded.
    * Only reachable with `reloadOnReconnect` off — with it on, Theia reloads the
    * page instead of opening another channel.
    */
   protected handleChannelOpen(): void {
      this.channelCount++;
      if (this.channelCount === 1) {
         this.logger.info(`initial channel opened on socket ${this.socketId()}`);
         return;
      }
      this.logger.warn(
         `new channel #${this.channelCount} on socket ${this.socketId()}: the backend did not recognise this frontend, ` +
            'so its session was discarded and every pending request rejected'
      );
   }

   protected handleStatusChange(status: ConnectionStatus): void {
      if (status === ConnectionStatus.ONLINE) {
         const offlineFor = this.offlineAt === undefined ? '' : ` after ${Date.now() - this.offlineAt} ms`;
         this.offlineAt = undefined;
         this.logger.info(`backend reachable again${offlineFor}`);
         return;
      }
      this.offlineAt = Date.now();
      const socket = this.connectionSource.socket;
      if (socket?.connected) {
         this.logger.warn(
            `backend stopped answering while socket ${socket.id} is still connected: nothing this session sends will ` +
               'arrive, and socket.io will not reconnect on its own. Reload the page to recover.'
         );
         return;
      }
      this.logger.info(`backend unreachable; websocket is disconnected (socket ${this.socketId()})`);
   }

   /**
    * The outage outlasted what the buffer can hold, so changes made from here on
    * are being thrown away rather than queued. Reconnecting resumes sending but
    * cannot bring those back, which leaves the editor disagreeing with the
    * server — and without a message the user would see nothing but an editor
    * that has quietly stopped saving, so say it plainly.
    */
   protected handleBufferOverflow(overflow: ConnectionBufferOverflow): void {
      this.logger.error(`buffer full at ${overflow.maxBytes} bytes holding ${overflow.messages} message(s)`);
      this.messageService.error(
         nls.localize(
            'hydranium/connection/offlineLimitReached',
            'Disconnected for too long: recent changes were not sent. Reload the page before continuing.'
         )
      );
   }

   protected socketId(): string {
      return this.connectionSource.socket?.id ?? WebSocketConnectionSource.NO_CONNECTION;
   }

   protected statusName(status: ConnectionStatus): string {
      return status === ConnectionStatus.ONLINE ? 'online' : 'offline';
   }
}

/**
 * Bind {@link ConnectionDiagnosticsContribution} as a `FrontendApplicationContribution`.
 *
 * Needs a {@link ChannelLogger} binding, so call it from a module that has also
 * called `bindChannelLogger`. Unlike `bindConnectionResilience` this belongs in a
 * normal frontend module: it only observes, so it has no reason to run during
 * preload, and `MessageService` is not available that early.
 */
export function bindConnectionDiagnostics(bind: interfaces.Bind): void {
   bind(ConnectionDiagnosticsContribution).toSelf().inSingletonScope();
   bind(FrontendApplicationContribution).toService(ConnectionDiagnosticsContribution);
}
