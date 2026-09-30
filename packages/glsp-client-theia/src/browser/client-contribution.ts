/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GLSPClient, type InitializeResult } from '@eclipse-glsp/client';
import { BaseGLSPClientContribution } from '@eclipse-glsp/theia-integration';
import { createChannelConnection, GLSPContribution } from '@eclipse-glsp/theia-integration/lib/common';
import { type Channel, Disposable, Event, nls, type Progress } from '@theia/core';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';

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
 * start still running after three seconds shows its progress, and ends in one
 * notification. A failed start rejects {@link glspClient}, and its
 * notification's Retry, like reading {@link glspClient} again, starts a fresh
 * client.
 *
 * A `GLSPClient` override filtering inbound messages by clientId is
 * deliberately NOT provided: upstream's `BaseJsonrpcGLSPClient.onActionMessage`
 * already filters by clientId, so the `TheiaJsonrpcGLSPClient` returned by
 * `BaseGLSPClientContribution.createGLSPClient` is correct as-is.
 */
@injectable()
export class HydraniumGlspClientContribution extends BaseGLSPClientContribution {
   @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;

   readonly id: string;

   /** The attempt waiting for a channel, if any. */
   protected channelRequest?: Deferred<Channel>;
   protected disposed = false;

   constructor(@unmanaged() options: ClientContributionOptions) {
      super();
      this.id = options.languageContributionId;
      this.glspClientStartupTimeout = options.startupTimeoutMs ?? DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS;
   }

   /** The client every diagram load awaits; after a failed start, a fresh one. */
   override get glspClient(): Promise<GLSPClient> {
      return this.glspClientDeferred.state === 'rejected' ? this.restart() : this.glspClientDeferred.promise;
   }

   /** Start a fresh client over a fresh channel if the last start failed. */
   restart(): Promise<GLSPClient> {
      if (!this.disposed && this.glspClientDeferred.state === 'rejected') {
         this.toDispose.dispose();
         // Upstream refuses to open a channel while the collection is disposed.
         this.toDispose.push(Disposable.NULL);
         this.glspClientDeferred = new Deferred<GLSPClient>();
         void this.activateClient();
      }
      return this.glspClientDeferred.promise;
   }

   /** Settles the promise current when it began, so a start a restart overtook
    *  cannot settle its successor. */
   protected override async activateClient(): Promise<void> {
      const pending = this.glspClientDeferred;
      await this.workspaceOpened();
      let progress: Promise<Progress> | undefined;
      const notice = setTimeout(() => (progress = this.showConnecting()), this.connectingNoticeDelayMs);
      const timeout =
         this.glspClientStartupTimeout > 0
            ? setTimeout(() => pending.reject(new Error(this.startupTimeoutMessage())), this.glspClientStartupTimeout)
            : undefined;
      pending.promise.then(
         () => {
            if (!this.disposed) {
               this.reportStarted(progress);
            }
         },
         (error: unknown) => {
            if (!this.disposed) {
               void this.reportStartFailure(error, progress);
            }
         }
      );
      void pending.promise
         .finally(() => {
            clearTimeout(notice);
            clearTimeout(timeout);
         })
         .catch(() => undefined);
      try {
         const connection = await this.createConnection();
         // Ahead of the client's own listener, whose teardown rejects with a
         // transport message instead.
         connection.onClose(() => pending.reject(new Error(this.unreachableMessage())));
         const client = await this.createGLSPClient(connection);
         connection.onDispose(() => client.stop());
         await this.start(client);
         pending.resolve(client);
      } catch (error: unknown) {
         pending.reject(error);
      }
   }

   /** Start the client and initialize its server, rejecting on failure; the
    *  caller settles {@link glspClient}. */
   protected override async start(glspClient: GLSPClient): Promise<void> {
      await glspClient.start();
      await this.initialize(glspClient);
   }

   /** Without upstream's own error notification, which would duplicate the result one. */
   protected override async initialize(glspClient: GLSPClient): Promise<InitializeResult> {
      return glspClient.initializeServer(await this.createInitializeParameters());
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
      this.glspClientDeferred.promise.catch(() => undefined);
      this.glspClientDeferred.reject(new Error('The diagram client was disposed.'));
      super.dispose();
   }

   protected async workspaceOpened(): Promise<void> {
      const roots = this.workspaceService.tryGetRoots();
      if (roots.length === 0) {
         await Event.toPromise(Event.filter(this.workspaceService.onWorkspaceChanged, changedRoots => changedRoots.length > 0));
      }
   }

   /** A start that takes longer than this shows a progress notification. */
   protected readonly connectingNoticeDelayMs: number = 3_000;

   protected showConnecting(): Promise<Progress> {
      return this.messageService.showProgress({
         text: nls.localize('hydranium/glsp-client-theia/diagram-server-connecting', 'Connecting to the diagram server…')
      });
   }

   /** A start that showed progress ends in a notification; a quick one stays silent. */
   protected reportStarted(progress: Promise<Progress> | undefined): void {
      if (progress) {
         void progress.then(shown => shown.cancel());
         this.messageService.info(nls.localize('hydranium/glsp-client-theia/diagram-server-connected', 'Connected to the diagram server.'));
      }
   }

   protected async reportStartFailure(error: unknown, progress: Promise<Progress> | undefined): Promise<void> {
      void progress?.then(shown => shown.cancel());
      const retry = nls.localize('hydranium/glsp-client-theia/diagram-retry', 'Retry');
      const choice = await this.messageService.error(error instanceof Error ? error.message : String(error), retry);
      if (choice === retry) {
         void this.restart();
      }
   }

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
