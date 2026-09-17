/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { renderFrameworkMessage, type DataPort, type ResolvedMessage } from '@hydranium/protocol';
import { Emitter, MessageService, nls, type Event } from '@theia/core';
import { type ServiceConnectionProvider } from '@theia/core/lib/browser';
import { RemoteConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import type { MessageConnection } from 'vscode-jsonrpc';
import { type ChannelConnectionHandle, openChannelConnection } from './channel-connection';
import { whenWorkspaceOpen } from './workspace-gate';

/**
 * A {@link DataPort} over a Theia frontend channel.
 *
 * Subclasses supply {@link servicePath}; everything above the port —
 * `DataConnection`, its sessions, and whatever model a widget drives — is
 * host-neutral and shared with the VS Code and browser shells.
 *
 * Bind one per service path and in singleton scope. Theia keys a frontend
 * channel by its path and refuses a second on a path already open, and the
 * throw escapes the `openChannelConnection` the loser is awaiting, leaving that
 * promise unsettled rather than rejected.
 */
@injectable()
export abstract class ChannelDataPort implements DataPort {
   @inject(RemoteConnectionProvider) protected readonly connectionProvider!: ServiceConnectionProvider;
   @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;
   @inject(MessageService) protected readonly messageService!: MessageService;

   /** Frontend service path the backend forwarder for this head is registered under. */
   protected abstract readonly servicePath: string;

   /**
    * Re-open the channel when the current connection is lost. Default `true` —
    * re-opening is the only thing that recovers a restarted language server,
    * which binds new ephemeral ports. Turn it off for a frontend that tears
    * itself down on transport loss instead.
    */
   protected readonly reconnectOnConnectionLoss: boolean = true;

   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;

   protected handle?: ChannelConnectionHandle;

   /**
    * Open the workspace-gated channel and hand back its listening connection.
    *
    * Gated because the backend forwarder discovers the head's port by executing
    * a command the language server answers, and the language server only
    * launches once there is a workspace to launch it for. Asking earlier polls
    * a command nobody has registered.
    */
   connect(): Promise<MessageConnection> {
      // Read per call rather than cached: `current` is repointed at a fresh
      // promise every time the channel is re-opened, so reading through the
      // handle is what makes a later generation reach the live server.
      if (!this.handle) {
         this.handle = openChannelConnection(this.connectionProvider, this.servicePath, {
            whenReady: whenWorkspaceOpen(this.workspaceService),
            reconnect: this.reconnectOnConnectionLoss
         });
         // A relaunched server binds new ephemeral ports; the handle re-opens
         // and the forwarder rediscovers, but `DataConnection` caches its
         // generation and would go on addressing the dead one. Its signal to
         // drop that generation is this event.
         this.handle.onDidLoseConnection(() => this.disposeEmitter.fire(undefined));
      }
      return this.handle.current;
   }

   /**
    * Surface a transport or write failure as a Theia notification.
    *
    * Swallowing it is the failure this exists to prevent: a dead connection and
    * an empty document are indistinguishable in a widget.
    *
    * `reported` is already a complete sentence with the detail interpolated, so
    * wrapping it in a sentence of the host's own would nest one owner's clause
    * inside another's and leave no translator in control of the whole.
    */
   reportError(_error: unknown, reported: ResolvedMessage): void {
      this.messageService.error(renderFrameworkMessage(reported, nls.localization?.translations));
   }

   dispose(): void {
      this.handle?.dispose();
      this.handle = undefined;
      this.disposeEmitter.fire(undefined);
      this.disposeEmitter.dispose();
   }
}
