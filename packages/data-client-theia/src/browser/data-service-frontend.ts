/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type DataPort,
   type ReadyServer,
   type ResolvedMessage,
   RpcConnection,
   type RpcProxy,
   renderFrameworkMessage
} from '@hydranium/protocol';
import { Emitter, nls, type MessageService } from '@theia/core';
import type { ServiceConnectionProvider } from '@theia/core/lib/browser';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import { type ChannelConnectionHandle, openChannelConnection } from './channel-connection';
import { whenWorkspaceOpen } from './workspace-gate';

/**
 * Base for a Theia frontend that owns the data-server vscode-jsonrpc
 * connection directly (the data head's "frontend speaks the model-server's
 * protocol over a relayed channel" pattern). Lifts the mechanical wiring —
 * the workspace-gated connection, the combined server proxy + inbound client
 * binding, and the lazy idempotent init gate — leaving the adopter to supply
 * the connection seams and any progress UI / domain caching / request-method
 * delegation on top.
 *
 * Generic over the server protocol `TServer` (must expose `waitForReady`) and
 * the local notification target `TClient`. A subclass supplies the abstract
 * members below, calls {@link start} from its `@postConstruct`, and awaits
 * {@link ensureConnected} before its first `this.server.*` call.
 *
 * The lifecycle is `RpcConnection`'s — the same proxy, readiness gate and
 * reconnect generation the host-neutral tier uses. What stays here is the Theia
 * half: the channel, the workspace gate and the notification sink.
 */
export abstract class AbstractDataServiceFrontend<TServer extends ReadyServer, TClient extends object> {
   protected abstract readonly connectionProvider: ServiceConnectionProvider;
   protected abstract readonly workspaceService?: WorkspaceService;
   protected abstract readonly client: TClient;
   /** Frontend service path the backend forwarder for this head is registered under. */
   protected abstract readonly servicePath: string;
   protected abstract readonly methodNamespace: string;
   /** Allowlist of {@link client} methods to bind as inbound handlers. */
   protected abstract readonly clientMethods: readonly (keyof TClient & string)[];

   /** Surfaces a transport failure. Optional: a frontend with no UI of its own omits it. */
   protected readonly messageService?: MessageService;

   /**
    * Rebuild the connection when the current one is lost. Defaults to `true` —
    * re-opening the channel is the only thing that recovers a restarted
    * language server, which binds new ephemeral ports. Turn it off for a
    * frontend that would rather tear itself down than show its warm-up twice.
    */
   protected readonly reconnectOnConnectionLoss: boolean = true;

   protected channel?: ChannelConnectionHandle;
   protected connection?: RpcConnection<TServer, TClient>;
   protected readonly lossEmitter = new Emitter<void>();

   /**
    * Readiness gate for the connection — the channel opens only once the
    * returned promise settles. Default: waits for a workspace when
    * {@link workspaceService} is provided, otherwise opens immediately.
    */
   protected connectionReadyGate(): Promise<void> | undefined {
      return this.workspaceService ? whenWorkspaceOpen(this.workspaceService) : undefined;
   }

   /** A connection generation is opening, including on each reconnect. */
   protected onConnecting(): void {
      // nothing by default
   }

   /** The server's readiness gate has settled for a generation. */
   protected onReady(): void {
      // nothing by default
   }

   /** A generation failed; the awaiting caller still rejects. */
   protected onFailed(_error: unknown): void {
      // nothing by default
   }

   /**
    * Open the channel and build the connection over it. Call once, typically
    * from the adopter's `@postConstruct`. Outbound calls and inbound
    * notifications queue until the channel is live.
    */
   protected start(): void {
      this.channel = openChannelConnection(this.connectionProvider, this.servicePath, {
         whenReady: this.connectionReadyGate(),
         reconnect: this.reconnectOnConnectionLoss
      });
      // The LOSS, not the replacement's arrival: the connection drops its
      // generation here, so a request made during the gap waits for the fresh
      // one instead of addressing the dead one and never settling.
      this.channel.onDidLoseConnection(() => this.lossEmitter.fire(undefined));
      this.connection = new RpcConnection<TServer, TClient>(this.channelPort(), this.client, {
         methodNamespace: this.methodNamespace,
         clientMethods: this.clientMethods,
         lifecycle: {
            onConnecting: () => this.onConnecting(),
            onReady: () => this.onReady(),
            onFailed: error => this.onFailed(error)
         }
      });
   }

   /** The channel as a {@link DataPort} — the whole Theia-specific half. */
   protected channelPort(): DataPort {
      return {
         // Read per call: `current` is repointed on every re-open, so reaching
         // through the handle is what makes a later generation find the live
         // server.
         connect: () => this.requireChannel().current,
         reportError: (_error, reported) => this.reportError(reported),
         onDispose: this.lossEmitter.event
      };
   }

   /** Surface a transport failure the way this host does. */
   protected reportError(reported: ResolvedMessage): void {
      this.messageService?.error(renderFrameworkMessage(reported, nls.localization?.translations));
   }

   /**
    * The server proxy. Calls queue against the connection, so await
    * {@link ensureConnected} first wherever the server's readiness matters.
    */
   protected get server(): RpcProxy<TServer> {
      return this.requireConnection().server;
   }

   /**
    * Await the connection and the server's readiness gate, shared across
    * concurrent callers and re-run once per connection generation.
    */
   protected async ensureConnected(): Promise<void> {
      await this.requireConnection().connected();
   }

   /**
    * Release the connection and stop tracking the channel. Idempotent.
    *
    * Subclasses that are Theia `Disposable`s should route their own disposal
    * here; nothing calls it automatically, because the base is not bound to a
    * lifecycle of its own.
    */
   dispose(): void {
      this.connection?.dispose();
      this.connection = undefined;
      this.channel?.dispose();
      this.channel = undefined;
      this.lossEmitter.dispose();
   }

   protected requireConnection(): RpcConnection<TServer, TClient> {
      if (!this.connection) {
         throw new Error('the connection is not open: call start() first');
      }
      return this.connection;
   }

   protected requireChannel(): ChannelConnectionHandle {
      if (!this.channel) {
         throw new Error('the channel is not open: call start() first');
      }
      return this.channel;
   }
}
