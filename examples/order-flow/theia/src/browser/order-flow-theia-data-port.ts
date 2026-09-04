/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ChannelConnectionHandle, openChannelConnection, whenWorkspaceOpen } from '@hydranium/data-client-theia/lib/browser';
import { DATA_SERVER_PATH, type DataPort } from '@hydranium/protocol';
import { Emitter, type Event, MessageService } from '@theia/core';
import { type ServiceConnectionProvider } from '@theia/core/lib/browser';
import { RemoteConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import type { MessageConnection } from 'vscode-jsonrpc';

/**
 * The Theia end of the data head's transport, as a {@link DataPort}.
 *
 * **This is the whole host-specific half of the properties panel**, and it is
 * short for the reason the port's own doc gives: in a Theia frontend the client
 * *is* the RPC endpoint, so opening the transport is one
 * `openChannelConnection` call. The VS Code shell needs an extension-side hop, a
 * messenger channel and a `postMessage` transport to reach the same place,
 * because a webview sandbox cannot hold a connection of its own — none of that
 * machinery has an analogue here and none of it is used.
 *
 * Everything above this class is shared verbatim with the VS Code shell:
 * `DataSession` owns readiness and reconnect, `OrderFlowPropertiesModel` owns
 * open/watch/write/reconcile, and `PropertiesForm` draws.
 *
 * Bound as a singleton so one connection serves the panel for the whole
 * session; the widget is document-scoped and long-lived, so there is nothing
 * per-document to tear down here.
 */
@injectable()
export class OrderFlowTheiaDataPort implements DataPort {
   @inject(RemoteConnectionProvider) protected readonly connectionProvider!: ServiceConnectionProvider;
   @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;
   @inject(MessageService) protected readonly messageService!: MessageService;

   /**
    * Distinct from the framework's own sentinels (`'language-client'`,
    * `'unknown'`, `'revert-on-close'`) and from the VS Code panel's id, because
    * it keys the server's per-`(uri, clientId)` watch bucket and is the echo key
    * an inbound `onDocumentUpdated` is matched against.
    */
   readonly clientId = 'order-flow-theia-properties';

   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;

   protected handle?: ChannelConnectionHandle;

   /**
    * Open the workspace-gated channel and hand back its listening connection.
    *
    * Workspace-gated for the reason `whenWorkspaceOpen` exists: the backend
    * forwarder discovers the data-server port by executing a command the
    * language server answers, and the language server only launches once there
    * is a workspace to launch it for. Asking earlier polls a command nobody has
    * registered.
    *
    * `openChannelConnection` already calls `listen()` on the connection it
    * builds, which is the contract {@link DataPort.connect} requires — the RPC
    * proxy queues calls but never listens itself.
    */
   connect(): Promise<MessageConnection> {
      // Read per call rather than cached: `current` is repointed at a fresh
      // promise every time the channel is re-opened, so reading through the
      // handle is what makes a later generation reach the live server.
      if (!this.handle) {
         this.handle = openChannelConnection(this.connectionProvider, DATA_SERVER_PATH, {
            whenReady: whenWorkspaceOpen(this.workspaceService)
         });
         // The port's half of restart recovery, and the whole of it.
         // `vscode-languageclient` relaunches this server on crash under new
         // ephemeral ports; the handle re-opens the channel and the backend
         // forwarder rediscovers the port, but `DataSession` caches its
         // connection generation and would go on addressing the dead one. Its
         // signal to drop that generation is the port's `onDispose`, so a
         // connection loss has to be reported as one — the same wiring the
         // webview port does from its `connectionLost`.
         this.handle.onDidLoseConnection(() => this.disposeEmitter.fire(undefined));
      }
      return this.handle.current;
   }

   /**
    * Surface a transport or write failure as a Theia notification.
    *
    * Swallowing it is the failure mode the port exists to prevent: a dead
    * connection and an empty document are indistinguishable in the panel.
    */
   reportError(error: unknown, context: string): void {
      const message = error instanceof Error ? error.message : String(error);
      this.messageService.error(`Order Flow properties — ${context}: ${message}`);
   }

   dispose(): void {
      this.handle?.dispose();
      this.handle = undefined;
      this.disposeEmitter.fire(undefined);
      this.disposeEmitter.dispose();
   }
}
