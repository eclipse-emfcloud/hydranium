/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ClientState, type GLSPClient, type InitializeResult } from '@eclipse-glsp/client';
import { BaseGLSPClientContribution } from '@eclipse-glsp/theia-integration';
import { createChannelConnection, GLSPContribution } from '@eclipse-glsp/theia-integration/lib/common';
import { ChannelLogger, ConnectionReporter, type ConnectionTarget } from '@hydranium/client-theia/lib/browser';
import { sendByMethodName } from '@hydranium/protocol';
import { type Channel, Disposable, Emitter, Event, nls } from '@theia/core';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
// GLSP's channel connection uses the top-level `vscode-jsonrpc`'s root entry, which
// installs no runtime layer; without the browser entry, no message is received.
import 'vscode-jsonrpc/browser';
import { HydraniumGlspClient } from './glsp-client';

export const DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS = 30_000;

/** Options for `HydraniumGlspClientContribution`. */
export interface ClientContributionOptions {
   readonly languageContributionId: string;
   /** How long a start may take, from the workspace opening to the server
    *  answering `initializeServer`, before it fails; `0` or less waits for good. */
   readonly startupTimeoutMs?: number;
}

/**
 * Theia GLSP client contribution for adopters whose GLSP server runs in a
 * sideloaded VS Code extension process (or any other deferred-start setup).
 *
 * The client starts once a workspace is open and sends its first request at
 * once; the backend handler holds it until its socket to the server is up. A
 * start that fails, and a connection lost after one succeeded, start a fresh
 * client after a backoff, for as long as the contribution lives. Each start is
 * reported through the {@link ConnectionReporter}, and announced through
 * {@link onDidStartClient} and {@link onDidLoseClient}.
 *
 * A `GLSPClient` override filtering inbound messages by clientId is
 * deliberately NOT provided: upstream's `BaseJsonrpcGLSPClient.onActionMessage`
 * already filters by clientId.
 */
@injectable()
export class HydraniumGlspClientContribution extends BaseGLSPClientContribution {
   @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;
   @inject(ConnectionReporter) protected readonly connectionReporter!: ConnectionReporter;
   @inject(ChannelLogger) protected readonly logger!: ChannelLogger;

   readonly id: string;

   /** Delay before the restart following each consecutive failed start or lost
    *  client; the last repeats. */
   protected readonly restartDelaysMs: readonly number[] = [1_000, 2_000, 4_000, 8_000];
   /** How long a client must stay up before the restart delays start over, so
    *  a server that fails right after starting is not restarted at once. */
   protected readonly restartEscalationResetMs: number = 30_000;
   protected consecutiveFailures = 0;
   protected restartTimer?: ReturnType<typeof setTimeout>;
   /** When the current client started; `0` once a restart has taken it into account. */
   protected startedAt = 0;
   /** Clients started so far, which numbers them in the log: they share {@link id}. */
   protected startedClients = 0;
   /** The attempt waiting for a channel, if any. */
   protected channelRequest?: Deferred<Channel>;
   protected disposed = false;
   protected readonly clientStartedEmitter = new Emitter<GLSPClient>();
   protected readonly clientLostEmitter = new Emitter<void>();

   /** Fires with each client once it has started and its server has answered. */
   readonly onDidStartClient: Event<GLSPClient> = this.clientStartedEmitter.event;
   /** Fires when the started client stops; {@link glspClient} already waits
    *  for its replacement then. */
   readonly onDidLoseClient: Event<void> = this.clientLostEmitter.event;

   constructor(@unmanaged() options: ClientContributionOptions) {
      super();
      this.id = options.languageContributionId;
      this.glspClientStartupTimeout = options.startupTimeoutMs ?? DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS;
   }

   /** The client every diagram load awaits; after a failed start, a fresh one. */
   override get glspClient(): Promise<GLSPClient> {
      return this.glspClientDeferred.state === 'rejected' ? this.restart() : this.glspClientDeferred.promise;
   }

   /** Start a fresh client over a fresh channel at once, if the last start failed. */
   restart(): Promise<GLSPClient> {
      if (!this.disposed && this.glspClientDeferred.state === 'rejected') {
         this.replaceClient();
         void this.activateClient();
      }
      return this.glspClientDeferred.promise;
   }

   /** Point {@link glspClient} at a fresh client still to start, and tear down
    *  the old one's channel. */
   protected replaceClient(): void {
      clearTimeout(this.restartTimer);
      // Replaced before the old channel goes, so the old client stopping is
      // not taken for a loss of the new one.
      this.glspClientDeferred = new Deferred<GLSPClient>();
      this.toDispose.dispose();
      // Upstream refuses to open a channel while the collection is disposed.
      this.toDispose.push(Disposable.NULL);
   }

   /** Settles the promise current when it began, so a start a restart overtook
    *  cannot settle its successor. */
   protected override async activateClient(): Promise<void> {
      const pending = this.glspClientDeferred;
      await this.workspaceOpened();
      if (this.disposed) {
         return;
      }
      const attempt = this.connectionReporter.connecting(this.connectionTarget);
      const timeout =
         this.glspClientStartupTimeout > 0
            ? setTimeout(() => pending.reject(new Error(this.startupTimeoutMessage())), this.glspClientStartupTimeout)
            : undefined;
      pending.promise.then(
         client => {
            clearTimeout(timeout);
            attempt.connected();
            this.startedAt = Date.now();
            this.logger.info(`[${this.id}] Diagram client ${++this.startedClients} started.`);
            this.clientStartedEmitter.fire(client);
            this.restartOnLoss(client);
         },
         (error: unknown) => {
            clearTimeout(timeout);
            if (this.disposed) {
               attempt.cancelled();
               return;
            }
            attempt.failed(error instanceof Error ? error.message : String(error), () => void this.restart());
            this.scheduleRestart(() => {
               if (this.glspClientDeferred === pending) {
                  void this.restart();
               }
            });
         }
      );
      try {
         const connection = await this.createConnection();
         // Ahead of the client's own listener, whose teardown rejects with a
         // transport message instead.
         connection.onClose(() => pending.reject(new Error(this.unreachableMessage())));
         // Upstream builds the connection from the `vscode-jsonrpc` hoisted
         // beside it and the client's typed messages from its protocol's copy;
         // a type sent over another copy's connection throws.
         const client = await this.createGLSPClient(sendByMethodName(connection));
         connection.onDispose(() => client.stop());
         await this.start(client);
         pending.resolve(client);
      } catch (error: unknown) {
         pending.reject(error);
      }
   }

   /** Run `restart` after the delay for the failures so far, and return that delay. */
   protected scheduleRestart(restart: () => void): number {
      if (this.startedAt > 0 && Date.now() - this.startedAt >= this.restartEscalationResetMs) {
         this.consecutiveFailures = 0;
      }
      this.startedAt = 0;
      const delay = this.restartDelaysMs[Math.min(this.consecutiveFailures, this.restartDelaysMs.length - 1)];
      this.consecutiveFailures++;
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(restart, delay);
      return delay;
   }

   /** Once `client` stops, replace it and start its replacement after the
    *  restart delay, unless a dispose stopped it. */
   protected restartOnLoss(client: GLSPClient): void {
      const listener = client.onCurrentStateChanged(state => {
         if (state !== ClientState.ServerError && state !== ClientState.Stopped) {
            return;
         }
         listener.dispose();
         if (!this.disposed) {
            this.replaceClient();
            this.clientLostEmitter.fire();
            const delay = this.scheduleRestart(() => void this.activateClient());
            // Upstream's client has just logged that it will not be restarted, which holds for it alone.
            this.logger.info(`[${this.id}] Diagram client ${this.startedClients} lost; starting a fresh one in ${delay} ms.`);
         }
      });
   }

   /** Start the client and initialize its server, rejecting on failure; the
    *  caller settles {@link glspClient}. */
   protected override async start(glspClient: GLSPClient): Promise<void> {
      await glspClient.start();
      await this.initialize(glspClient);
   }

   /** Without upstream's own error notification, which would duplicate the reporter's. */
   protected override async initialize(glspClient: GLSPClient): Promise<InitializeResult> {
      return glspClient.initializeServer(await this.createInitializeParameters());
   }

   /** Upstream's base client, without the notifications of its Theia subclass,
    *  which would duplicate the reporter's. */
   protected override async createGLSPClient(
      connectionProvider: Parameters<BaseGLSPClientContribution['createGLSPClient']>[0]
   ): Promise<GLSPClient> {
      return new HydraniumGlspClient({ id: this.id, connectionProvider });
   }

   /**
    * Whichever channel arrives goes to the attempt waiting now, and one that
    * arrives with none waiting is closed. Theia holds each open until its
    * websocket is back, and after an outage every held open past the first
    * throws "already open" without reaching its handler, so the first to arrive
    * has to serve the latest attempt. Without Theia's replay, which would be a
    * second opener of the same path.
    */
   protected override async createChannelConnection(): ReturnType<BaseGLSPClientContribution['createChannelConnection']> {
      this.channelRequest?.reject(new Error('A newer start took over the channel request.'));
      const request = new Deferred<Channel>();
      this.channelRequest = request;
      this.connectionProvider.listen(
         GLSPContribution.getPath(this),
         (_path, channel) => {
            const waiting = this.channelRequest;
            this.channelRequest = undefined;
            if (waiting && !this.disposed) {
               waiting.resolve(channel);
            } else {
               channel.close();
            }
         },
         false
      );
      const channel = await request.promise;
      const connection = createChannelConnection(channel);
      this.toDispose.push(Disposable.create(() => this.disposeChannel(connection, channel)));
      return connection;
   }

   /** Also closes the channel: upstream leaves a Theia channel open, and the
    *  next one on the same path then cannot open. */
   protected override async disposeChannel(
      connection: Parameters<BaseGLSPClientContribution['disposeChannel']>[0],
      channel: Channel
   ): Promise<void> {
      await super.disposeChannel(connection, channel);
      channel.close();
   }

   /** Also fails a start in flight, so nothing reports it after this. */
   override dispose(): void {
      this.disposed = true;
      clearTimeout(this.restartTimer);
      this.glspClientDeferred.promise.catch(() => undefined);
      this.glspClientDeferred.reject(new Error('The diagram client was disposed.'));
      this.clientStartedEmitter.dispose();
      this.clientLostEmitter.dispose();
      super.dispose();
   }

   protected async workspaceOpened(): Promise<void> {
      const roots = this.workspaceService.tryGetRoots();
      if (roots.length === 0) {
         await Event.toPromise(Event.filter(this.workspaceService.onWorkspaceChanged, changedRoots => changedRoots.length > 0));
      }
   }

   protected get connectionTarget(): ConnectionTarget {
      return (this.cachedConnectionTarget ??= {
         connectingMessage: nls.localize('hydranium/glsp-client-theia/diagram-server-connecting', 'Connecting to the diagram server…'),
         connectedMessage: nls.localize('hydranium/glsp-client-theia/diagram-server-connected', 'Connected to the diagram server.')
      });
   }
   /** One object per contribution: the reporter keys what it has shown on it. */
   protected cachedConnectionTarget?: ConnectionTarget;

   protected unreachableMessage(): string {
      return nls.localize('hydranium/glsp-client-theia/diagram-server-unreachable', 'Could not connect to the diagram server.');
   }

   protected startupTimeoutMessage(): string {
      return nls.localize(
         'hydranium/glsp-client-theia/diagram-server-timeout',
         'The diagram server did not answer within {0} seconds.',
         String(Math.round(this.glspClientStartupTimeout / 1000))
      );
   }
}
