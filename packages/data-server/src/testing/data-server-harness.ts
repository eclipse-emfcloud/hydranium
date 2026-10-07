/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createRpcProxy, type Project, type TransferDiagnostic, type TransferElement } from '@hydranium/protocol';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerProtocol,
   type ProjectsChangedEvent,
   type TransferDocumentDeletedEvent,
   type TransferDocumentDirtyChangedEvent,
   type TransferDocumentSavedEvent,
   type TransferDocumentsBuiltEvent,
   type TransferDocumentUpdatedEvent
} from '@hydranium/protocol/data';
import { type AdditionalClientMethod, type Harness, makeCapturingDataClient } from '@hydranium/protocol/testing';
import { makeDuplexConnectionPair, type DuplexConnectionPair } from '@hydranium/protocol/testing/node';
import type { MessageConnection } from 'vscode-jsonrpc/node';

/**
 * Configuration for {@link makeDataServerHarness}.
 *
 * `server` is the only required field — a factory that constructs the
 * DataServer subclass under test against the supplied {@link MessageConnection}
 * (the "server side" of the duplex pair). The factory is invoked once,
 * synchronously, after the pair is wired.
 *
 * `client` lets tests override individual handlers on the captured client.
 * Unspecified handlers default to pushing incoming events into the
 * {@link DataServerHarness} bundle's `events` / `saves` / `projectsChanges`
 * arrays — the typical assertion target.
 */
export interface MakeDataServerHarnessOptions<
   TServer,
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project,
   TClient extends DataClientProtocol<TTransfer, TDiagnostic, TProject> = DataClientProtocol<TTransfer, TDiagnostic, TProject>
> {
   /**
    * Construct the `DataServer` (or subclass) under test against
    * `channel`. The harness invokes this once after `pair.left` is
    * established.
    */
   server: (channel: MessageConnection) => TServer;
   /**
    * Override per-method handlers on the captured client. An additional
    * method's override needs the method in `additionalClientMethods`, or the
    * harness throws. Each overridden handler REPLACES the default (which
    * pushes into the bundle's capture arrays); test code wanting to BOTH
    * capture AND react should push to the array manually inside the override.
    */
   client?: Partial<TClient>;
   /**
    * Notification methods `TClient` adds to {@link DataClientProtocol}. Each is
    * bound and captured into `additionalNotifications`; one left out reaches no
    * handler.
    */
   additionalClientMethods?: readonly AdditionalClientMethod<TClient>[];
   /**
    * Wire namespace the proxy addresses the server under. Defaults to
    * {@link DATA_SERVER_WIRE_PREFIX}. Override when the `DataServer`
    * subclass registers under a custom namespace (its constructor's
    * `methodNamespace` option). Must match the server's namespace, or every
    * request is "Unhandled method".
    */
   methodNamespace?: string;
}

/**
 * Wiring bundle returned by {@link makeDataServerHarness}. Satisfies the
 * uniform {@link Harness} contract — `server` is the **subject** (the
 * DataServer under test), `proxy`/`pair` are the **seam** (the typed RPC
 * proxy tests drive the subject through, plus the underlying duplex pair),
 * `events`/`saves`/`projectsChanges` are the **capture arrays** for inbound
 * client-side events, and `dispose()` is the uniform teardown hook.
 *
 * `dispose()` releases the duplex pair (and therefore both
 * {@link MessageConnection}s); call at test teardown.
 */
export interface DataServerHarness<
   TServer,
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project,
   TClient extends DataClientProtocol<TTransfer, TDiagnostic, TProject> = DataClientProtocol<TTransfer, TDiagnostic, TProject>
> extends Harness {
   readonly server: TServer;
   readonly proxy: DataServerProtocol<TTransfer, TDiagnostic, TProject>;
   readonly pair: DuplexConnectionPair;
   /** Captured `onDocumentUpdated` events — append order; never cleared by the harness. */
   readonly events: ReadonlyArray<TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>>;
   /** Captured `onDocumentSaved` events. */
   readonly saves: ReadonlyArray<TransferDocumentSavedEvent<TTransfer, TDiagnostic>>;
   /** Captured `onDocumentDirtyChanged` events. */
   readonly dirtyChanges: ReadonlyArray<TransferDocumentDirtyChangedEvent>;
   /** Captured `onDocumentDeleted` events. */
   readonly deletions: ReadonlyArray<TransferDocumentDeletedEvent>;
   /** Captured `onDocumentsBuilt` events, one per build that had unwatched documents. */
   readonly builds: ReadonlyArray<TransferDocumentsBuiltEvent>;
   /** Captured `onProjectsChanged` events. */
   readonly projectsChanges: ReadonlyArray<ProjectsChangedEvent<TProject>>;
   /** Captured events of each `additionalClientMethods` entry, keyed by method. */
   readonly additionalNotifications: {
      readonly [K in AdditionalClientMethod<TClient>]: TClient[K] extends (event: infer TEvent) => void ? ReadonlyArray<TEvent> : never;
   };
   /** Dispose the underlying duplex pair. Idempotent. */
   dispose(): void;
}

/**
 * Wire a DataServer + local {@link DataClientProtocol} + typed RPC proxy
 * over an in-process duplex {@link MessageConnection} pair. Tests then
 * exercise the server via `harness.proxy.*()` and assert on
 * `harness.events` / `harness.saves` / `harness.projectsChanges`.
 *
 * Moves the duplex pair, the local client and the proxy construction behind
 * a single factory call, so a test file carries only its own setup: seeded
 * documents, server options, assertions.
 */
export function makeDataServerHarness<
   TServer,
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project,
   TClient extends DataClientProtocol<TTransfer, TDiagnostic, TProject> = DataClientProtocol<TTransfer, TDiagnostic, TProject>
>(
   options: MakeDataServerHarnessOptions<TServer, TTransfer, TDiagnostic, TProject, TClient>
): DataServerHarness<TServer, TTransfer, TDiagnostic, TProject, TClient> {
   const pair = makeDuplexConnectionPair();
   const server = options.server(pair.left);
   const additionalClientMethods = options.additionalClientMethods ?? [];

   // The capture half is the shared client double, not a local copy: the same
   // recording semantics (every channel, an override replacing rather than
   // supplementing) then hold for a client-side suite that stands the double up
   // without a server, so an assertion learnt against one reads the same in the
   // other.
   const {
      client: localClient,
      updates: events,
      saves,
      dirtyChanges,
      deletions,
      builds,
      projectsChanges,
      additionalNotifications
   } = makeCapturingDataClient<TTransfer, TDiagnostic, TProject, TClient>(options.client, additionalClientMethods);

   const proxy = createRpcProxy<DataServerProtocol<TTransfer, TDiagnostic, TProject>, TClient>(pair.right, {
      methodNamespace: options.methodNamespace ?? DATA_SERVER_WIRE_PREFIX,
      localTarget: localClient,
      localMethods: [...DATA_CLIENT_PROTOCOL_METHODS, ...additionalClientMethods]
   });

   return {
      server,
      proxy,
      pair,
      events,
      saves,
      dirtyChanges,
      deletions,
      builds,
      projectsChanges,
      additionalNotifications,
      dispose: () => pair.dispose()
   };
}
