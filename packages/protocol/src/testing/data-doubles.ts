/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The two CLIENT-side doubles of the data head: a {@link DataPort} whose
 * transport the test supplies, and a {@link DataClientProtocol} that records
 * what arrived.
 *
 * # Why standalone, when a harness already builds one
 *
 * `makeDataServerHarness` builds a capturing client too, but fused into a
 * server-bearing harness: taking it means taking a duplex pair, a `DataServer`
 * and a proxy. That is the right shape for testing the server. It is the wrong
 * shape — and not available at all — for testing the CLIENT half: a
 * `DataSession`, a widget model, a host's port adapter. Those need to stand a
 * double on one side of the boundary and something else entirely on the other,
 * which is why both halves get hand-rolled per suite instead.
 *
 * # Runner-agnostic, deliberately
 *
 * No `jest.fn`, no `vi.fn`, no `expect`. The recorded arrays ARE the assertion
 * surface, so the same double works under vitest, jest and a bare script. A
 * mock-framework double would also make "was it called" the observable, when
 * what a data-head test actually asserts is the CONTENT of what arrived —
 * which `sourceClientId`, which version, which reason.
 */

import { Emitter, type MessageConnection } from 'vscode-jsonrpc';
import type { DataPort } from '../client/data-port';
import { DATA_CLIENT_PROTOCOL_METHODS } from '../data/data-protocol-methods';
import type { DataClientProtocol } from '../data/data-server-protocol';
import type {
   ProjectsChangedEvent,
   TransferDocumentDeletedEvent,
   TransferDocumentDirtyChangedEvent,
   TransferDocumentSavedEvent,
   TransferDocumentsBuiltEvent,
   TransferDocumentUpdatedEvent
} from '../data/events';
import type { Logger } from '../logger';
import type { ResolvedMessage } from '../messages/primitives';
import type { RpcProxyLifecycle } from '../rpc/create-rpc-proxy';
import type { Project } from '../project';
import type { TransferDiagnostic } from '../transfer-diagnostic';
import type { TransferElement } from '../transfer-element';

/** Inputs to {@link makeFakeDataPort}. */
export interface FakeDataPortOptions {
   /**
    * Establish one transport generation and hand back a LISTENING connection —
    * the port's whole contract. Called once per generation, so a test that
    * asserts on reconnection must return a FRESH connection each time rather
    * than closing over one.
    *
    * Throwing (or rejecting) here is the transport-construction failure path,
    * which the consumer surfaces through {@link FakeDataPort.reported}.
    *
    * The double disposes none of these connections and goes on connecting
    * after its dispose, where a real port releases its connection and refuses:
    * the test owns them.
    */
   connect(): MessageConnection | Promise<MessageConnection>;
   /** The port's {@link DataPort.logger}. */
   logger?: Logger;
}

/** A {@link DataPort} that records what passed through it. */
export interface FakeDataPort extends DataPort {
   /**
    * Every connection {@link FakeDataPortOptions.connect} handed back, in
    * order. Read from outside: "one connection shared across concurrent
    * callers" and "a fresh connection after a teardown" are assertions about
    * this length and about nothing else observable — a session that memoised a
    * rejected promise, for instance, differs from one that retries ONLY here.
    */
   readonly connections: readonly MessageConnection[];
   /**
    * Every {@link DataPort.reportError} call, in order. Read from outside: this
    * is the only place a transport failure surfaces, so a test for the failure
    * path asserts here rather than on a rejection the consumer may legitimately
    * swallow. Prefer asserting on `message.code`, which is stable, over
    * `message.text`, which is the English default and may be reworded.
    */
   readonly reported: readonly { readonly error: unknown; readonly message: ResolvedMessage }[];
   /**
    * Fire {@link DataPort.onDispose} — the host tearing the transport down, a
    * language-server restart being the case that forces the event to exist.
    * Drives the consumer's reconnection path, which has no other trigger.
    */
   fireDispose(): void;
   /** Release the emitter. Idempotent; does not close the connections, which the test owns. */
   dispose(): void;
}

/**
 * A {@link DataPort} over a transport the caller supplies.
 *
 * It deliberately does not create the transport itself. What varies between the
 * cases worth testing is exactly that: an in-process duplex pair, a socket, a
 * connection with no server behind it, a different one per generation.
 */
export function makeFakeDataPort(options: FakeDataPortOptions): FakeDataPort {
   const connections: MessageConnection[] = [];
   const reported: { error: unknown; message: ResolvedMessage }[] = [];
   const disposeEmitter = new Emitter<void>();
   return {
      connections,
      reported,
      logger: options.logger,
      onDispose: disposeEmitter.event,
      async connect(): Promise<MessageConnection> {
         const connection = await options.connect();
         connections.push(connection);
         return connection;
      },
      reportError(error: unknown, message: ResolvedMessage): void {
         reported.push({ error, message });
      },
      fireDispose(): void {
         disposeEmitter.fire(undefined);
      },
      dispose(): void {
         disposeEmitter.dispose();
      }
   };
}

type UpperLetter =
   | 'A'
   | 'B'
   | 'C'
   | 'D'
   | 'E'
   | 'F'
   | 'G'
   | 'H'
   | 'I'
   | 'J'
   | 'K'
   | 'L'
   | 'M'
   | 'N'
   | 'O'
   | 'P'
   | 'Q'
   | 'R'
   | 'S'
   | 'T'
   | 'U'
   | 'V'
   | 'W'
   | 'X'
   | 'Y'
   | 'Z';

/**
 * A notification name `TClient` adds to {@link DataClientProtocol}. Limited to
 * `on` plus a letter A–Z, the names the proxy sends as notifications; any other
 * name would be bound as a request. The {@link RpcProxyLifecycle} names are
 * excluded too: the proxy returns its own events for them and sends nothing.
 */
export type AdditionalClientMethod<TClient> = Exclude<keyof TClient, keyof DataClientProtocol<TransferElement> | keyof RpcProxyLifecycle> &
   `on${UpperLetter}${string}`;

/** A {@link DataClientProtocol} plus the arrays it records into. */
export interface CapturingDataClient<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project,
   TClient extends DataClientProtocol<TTransfer, TDiagnostic, TProject> = DataClientProtocol<TTransfer, TDiagnostic, TProject>
> {
   /** The client to hand to a `DataSession` or bind as an RPC `localTarget`. */
   readonly client: TClient;
   /** Every `onDocumentUpdated` event, in arrival order. */
   readonly updates: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>[];
   /** Every `onDocumentSaved` event, in arrival order. */
   readonly saves: TransferDocumentSavedEvent<TTransfer, TDiagnostic>[];
   /** Every `onDocumentDirtyChanged` event, in arrival order. */
   readonly dirtyChanges: TransferDocumentDirtyChangedEvent[];
   /** Every `onDocumentDeleted` event, in arrival order. */
   readonly deletions: TransferDocumentDeletedEvent[];
   /** Every `onDocumentsBuilt` event, in arrival order. */
   readonly builds: TransferDocumentsBuiltEvent[];
   /** Every `onProjectsChanged` event, in arrival order. */
   readonly projectsChanges: ProjectsChangedEvent<TProject>[];
   /**
    * Every event of each additional client method, keyed by method, in arrival
    * order. A method of `TClient` left out of `additionalClientMethods` has no
    * entry.
    */
   readonly additionalNotifications: {
      readonly [K in AdditionalClientMethod<TClient>]: TClient[K] extends (event: infer TEvent) => void ? TEvent[] : never;
   };
}

/**
 * A {@link DataClientProtocol} that records every notification it receives.
 *
 * Recording EVERY channel even when a suite reads one is deliberate: an
 * event delivered on the wrong channel is a real defect of the data head, and a
 * double that drops the other two turns it into silence on the one being
 * watched.
 *
 * An override replaces a channel's recording rather than supplementing it, so
 * the corresponding array stays empty — that is what makes an override usable
 * as a barrier (rejecting, counting differently, throwing) rather than only as
 * a spy.
 *
 * `additionalClientMethods` names the notifications `TClient` adds to
 * {@link DataClientProtocol}. Each is recorded and overridable the same way;
 * one left out is not on the client at all, and overriding it throws, since
 * nothing would call the override.
 */
export function makeCapturingDataClient<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project,
   TClient extends DataClientProtocol<TTransfer, TDiagnostic, TProject> = DataClientProtocol<TTransfer, TDiagnostic, TProject>
>(
   overrides: Partial<TClient> = {},
   additionalClientMethods: readonly AdditionalClientMethod<TClient>[] = []
): CapturingDataClient<TTransfer, TDiagnostic, TProject, TClient> {
   const bound = new Set<string>([...DATA_CLIENT_PROTOCOL_METHODS, ...additionalClientMethods]);
   for (const name of Object.keys(overrides)) {
      if (!bound.has(name)) {
         throw new Error(
            `Override '${name}' is neither a DataClientProtocol method nor listed in additionalClientMethods, so nothing would call it.`
         );
      }
   }
   const frameworkOverrides: Partial<DataClientProtocol<TTransfer, TDiagnostic, TProject>> = overrides;
   const updates: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>[] = [];
   const saves: TransferDocumentSavedEvent<TTransfer, TDiagnostic>[] = [];
   const dirtyChanges: TransferDocumentDirtyChangedEvent[] = [];
   const deletions: TransferDocumentDeletedEvent[] = [];
   const builds: TransferDocumentsBuiltEvent[] = [];
   const projectsChanges: ProjectsChangedEvent<TProject>[] = [];
   const frameworkClient: DataClientProtocol<TTransfer, TDiagnostic, TProject> = {
      onDocumentUpdated:
         frameworkOverrides.onDocumentUpdated ??
         (event => {
            updates.push(event);
         }),
      onDocumentSaved:
         frameworkOverrides.onDocumentSaved ??
         (event => {
            saves.push(event);
         }),
      onDocumentDirtyChanged:
         frameworkOverrides.onDocumentDirtyChanged ??
         (event => {
            dirtyChanges.push(event);
         }),
      onDocumentDeleted:
         frameworkOverrides.onDocumentDeleted ??
         (event => {
            deletions.push(event);
         }),
      onDocumentsBuilt:
         frameworkOverrides.onDocumentsBuilt ??
         (event => {
            builds.push(event);
         }),
      onProjectsChanged:
         frameworkOverrides.onProjectsChanged ??
         (event => {
            projectsChanges.push(event);
         })
   };
   const additionalNotifications: Record<string, unknown[]> = {};
   const additionalHandlers: Record<string, unknown> = {};
   for (const method of additionalClientMethods) {
      const events: unknown[] = [];
      additionalNotifications[method] = events;
      additionalHandlers[method] =
         overrides[method] ??
         ((event: unknown) => {
            events.push(event);
         });
   }
   return {
      client: { ...frameworkClient, ...additionalHandlers } as unknown as TClient,
      updates,
      saves,
      dirtyChanges,
      deletions,
      builds,
      projectsChanges,
      additionalNotifications: additionalNotifications as CapturingDataClient<
         TTransfer,
         TDiagnostic,
         TProject,
         TClient
      >['additionalNotifications']
   };
}
