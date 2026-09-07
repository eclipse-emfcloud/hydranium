/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createRpcProxy } from '@hydranium/protocol';
import type { ServiceConnectionProvider } from '@theia/core/lib/browser';
import { Deferred } from '@theia/core/lib/common/promise-util';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import type { MessageConnection } from 'vscode-jsonrpc';
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
 */
export abstract class AbstractDataServiceFrontend<TServer extends { waitForReady(): Promise<void> }, TClient extends object> {
   /**
    * The workspace-gated connection to the backend forwarder. Set by
    * {@link start}, and REPLACED whenever the connection is lost and
    * {@link reconnectOnConnectionLoss} is on — so read it per use and never
    * cache the resolved connection.
    */
   protected connectionPromise!: Promise<MessageConnection>;
   /**
    * Typed proxy over {@link connectionPromise}, addressing the server under
    * {@link methodNamespace}. Set by {@link start}, and replaced alongside
    * {@link connectionPromise} on reconnect.
    *
    * `createRpcProxy` resolves the connection promise once and binds to it for
    * good, so a reconnect necessarily means a new proxy. Reading
    * `this.server.foo()` per call — rather than hoisting `this.server` into a
    * local or a constructor-time field — is what keeps a subclass correct
    * across one.
    */
   protected server!: TServer;
   /** The channel handle {@link start} opened; owns reconnect and disposal. */
   protected channel?: ChannelConnectionHandle;
   /** Shared init Deferred so concurrent {@link ensureConnected} callers await one initialization. */
   protected initialized?: Deferred<void>;

   /** Theia connection provider the channel is opened through. */
   protected abstract readonly connectionProvider: ServiceConnectionProvider;
   /**
    * Optional workspace service. When provided, the default
    * {@link connectionReadyGate} waits for a workspace before opening the
    * channel; a head that is not workspace-scoped omits it (and may override
    * {@link connectionReadyGate} for a different gate).
    */
   protected abstract readonly workspaceService?: WorkspaceService;
   /** Local inbound-notification target bound on the connection (the `localTarget`). */
   protected abstract readonly client: TClient;
   /**
    * Theia service path the backend forwarder is registered under.
    *
    * **Unique per frontend, not per server.** Theia keys a frontend channel by
    * this path and throws `Another channel with the id '<path>' is already open`
    * on a second opener — so a subclass sharing the framework default with any
    * other consumer of the same head (a host-neutral `DataPort`, a sibling
    * service frontend) breaks whichever opens second. The failure is remote from
    * its cause: the throw escapes an `openChannelConnection` the other consumer
    * awaited, leaving its request permanently unsettled rather than rejected,
    * which presents as a view stuck on its loading state with a clean server
    * log. Give each frontend its own path and register a forwarder per path;
    * they still reach one server, since the shared `portCommand` is what names
    * the process.
    */
   protected abstract readonly servicePath: string;
   /** Wire namespace the server + client methods are addressed under. */
   protected abstract readonly methodNamespace: string;
   /** Allowlist of {@link client} methods to bind as inbound handlers. */
   protected abstract readonly clientMethods: readonly (keyof TClient & string)[];

   /**
    * Rebuild the connection and the proxy when the current connection is lost,
    * and re-run initialization against the replacement. Defaults to `true` —
    * see `OpenChannelConnectionOptions.reconnect` for why re-opening the
    * channel is the only thing that recovers a restarted language server, and
    * why a dead connection leaves no alternative worth preserving.
    *
    * The subclass-facing cost is that {@link doInitialize} runs again per
    * connection, so any progress UI it drives reappears. Turn this off for a
    * frontend that would rather show nothing than show its warm-up twice, or
    * that tears itself down on transport loss.
    */
   protected readonly reconnectOnConnectionLoss: boolean = true;

   /**
    * Readiness gate for the connection — the channel opens only once the
    * returned promise settles. Default: waits for a workspace when
    * {@link workspaceService} is provided, otherwise opens immediately
    * (`undefined`). Override for a different gate (e.g. a fixed model store
    * that is always ready, or a custom warm-up).
    */
   protected connectionReadyGate(): Promise<void> | undefined {
      return this.workspaceService ? whenWorkspaceOpen(this.workspaceService) : undefined;
   }

   /**
    * Open the connection (workspace-gated by default via
    * {@link connectionReadyGate}) and build the combined server proxy +
    * inbound client binding. Call once (typically from the adopter's
    * `@postConstruct`). Outbound calls + inbound notifications queue over the
    * connection promise until the channel is live.
    */
   protected start(): void {
      this.channel = openChannelConnection(this.connectionProvider, this.servicePath, {
         whenReady: this.connectionReadyGate(),
         reconnect: this.reconnectOnConnectionLoss
      });
      this.bindConnection();
      // The LOSS, not the replacement's arrival: rebinding when the channel
      // closes points `server` at the queueing replacement promise, so a request
      // made during the gap waits for the new server instead of being addressed
      // at the dead one and never settling.
      this.channel.onDidLoseConnection(() => this.handleConnectionLost());
   }

   /**
    * Point {@link connectionPromise} and {@link server} at the channel's
    * current connection. Called by {@link start} and again per reconnect.
    */
   protected bindConnection(): void {
      if (!this.channel) {
         throw new Error('bindConnection called before start');
      }
      this.connectionPromise = this.channel.current;
      this.server = createRpcProxy<TServer, TClient>(this.connectionPromise, {
         methodNamespace: this.methodNamespace,
         localTarget: this.client,
         localMethods: this.clientMethods
      });
   }

   /**
    * Rebind onto the replacement connection and arm initialization to run again.
    *
    * Clearing {@link initialized} is the load-bearing half. A restarted server
    * has an unwarmed workspace, so its `waitForReady` gate has to be awaited
    * afresh; leaving the old resolved Deferred in place would let the first
    * request after a restart through against a server still walking the
    * workspace, and be answered correctly from an empty registry — which reads
    * as data loss rather than as a race.
    */
   protected handleConnectionLost(): void {
      this.initialized = undefined;
      this.bindConnection();
   }

   /**
    * Release the connection and stop tracking the channel. Idempotent.
    *
    * Subclasses that are Theia `Disposable`s should route their own disposal
    * here; nothing calls it automatically, because the base is not bound to a
    * lifecycle of its own.
    */
   dispose(): void {
      this.channel?.dispose();
      this.channel = undefined;
      this.initialized = undefined;
   }

   /**
    * Lazily drive initialization, shared across concurrent callers via one
    * {@link Deferred}. Request methods `await this.ensureConnected()` before
    * their first `this.server.*` call.
    */
   protected ensureConnected(): Promise<void> {
      if (!this.initialized) {
         this.initialized = new Deferred<void>();
         void this.doInitialize(this.initialized);
      }
      return this.initialized.promise;
   }

   /**
    * Default initialization: await the connection, await the server's readiness
    * gate, then resolve the passed Deferred. Initialization completion is
    * observable by awaiting {@link ensureConnected} (which returns this same
    * Deferred's promise) — there is no separate post-init hook. Override
    * wholesale to interleave progress UI / extra warm-up; an override owns
    * resolving/rejecting `initialized` (there is no `super` step to call).
    */
   protected async doInitialize(initialized: Deferred<void>): Promise<void> {
      try {
         await this.connectionPromise;
         await this.server.waitForReady();
         initialized.resolve();
      } catch (error) {
         initialized.reject(error instanceof Error ? error : new Error(String(error)));
      }
   }
}
