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
import type { DataClientProtocol } from '../data/data-server-protocol';
import type { ProjectsChangedEvent, TransferDocumentSavedEvent, TransferDocumentUpdatedEvent } from '../data/events';
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
    */
   connect(): MessageConnection | Promise<MessageConnection>;
   /**
    * Stable client identity. Defaults to `'fake-data-port'`, which avoids the
    * three sentinels the framework reserves (`'language-client'`, `'unknown'`,
    * `'revert-on-close'`); override it when a test needs two distinguishable
    * clients on one server.
    */
   clientId?: string;
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
    * path asserts on the `context` string here rather than on a rejection that
    * the consumer may legitimately swallow.
    */
   readonly reported: readonly { readonly error: unknown; readonly context: string }[];
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
   const reported: { error: unknown; context: string }[] = [];
   const disposeEmitter = new Emitter<void>();
   return {
      clientId: options.clientId ?? 'fake-data-port',
      connections,
      reported,
      onDispose: disposeEmitter.event,
      async connect(): Promise<MessageConnection> {
         const connection = await options.connect();
         connections.push(connection);
         return connection;
      },
      reportError(error: unknown, context: string): void {
         reported.push({ error, context });
      },
      fireDispose(): void {
         disposeEmitter.fire(undefined);
      },
      dispose(): void {
         disposeEmitter.dispose();
      }
   };
}

/** A {@link DataClientProtocol} plus the arrays it records into. */
export interface CapturingDataClient<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project
> {
   /** The client to hand to a `DataSession` or bind as an RPC `localTarget`. */
   readonly client: DataClientProtocol<TTransfer, TDiagnostic, TProject>;
   /** Every `onDocumentUpdated` event, in arrival order. */
   readonly updates: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>[];
   /** Every `onDocumentSaved` event, in arrival order. */
   readonly saves: TransferDocumentSavedEvent<TTransfer, TDiagnostic>[];
   /** Every `onProjectsChanged` event, in arrival order. */
   readonly projectsChanges: ProjectsChangedEvent<TProject>[];
}

/**
 * A {@link DataClientProtocol} that records every notification it receives.
 *
 * Recording ALL THREE channels even when a suite reads one is deliberate: an
 * event delivered on the wrong channel is a real defect of the data head, and a
 * double that drops the other two turns it into silence on the one being
 * watched.
 *
 * An override replaces a channel's recording rather than supplementing it, so
 * the corresponding array stays empty — that is what makes an override usable
 * as a barrier (rejecting, counting differently, throwing) rather than only as
 * a spy.
 */
export function makeCapturingDataClient<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project
>(overrides: Partial<DataClientProtocol<TTransfer, TDiagnostic, TProject>> = {}): CapturingDataClient<TTransfer, TDiagnostic, TProject> {
   const updates: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>[] = [];
   const saves: TransferDocumentSavedEvent<TTransfer, TDiagnostic>[] = [];
   const projectsChanges: ProjectsChangedEvent<TProject>[] = [];
   const client: DataClientProtocol<TTransfer, TDiagnostic, TProject> = {
      onDocumentUpdated:
         overrides.onDocumentUpdated ??
         (event => {
            updates.push(event);
         }),
      onDocumentSaved:
         overrides.onDocumentSaved ??
         (event => {
            saves.push(event);
         }),
      onProjectsChanged:
         overrides.onProjectsChanged ??
         (event => {
            projectsChanges.push(event);
         })
   };
   return { client, updates, saves, projectsChanges };
}
