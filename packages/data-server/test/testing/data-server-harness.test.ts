/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeDataServerHarness` — the WIRING, isolated from any particular server.
 *
 * The harness doubles nothing, so there is no interface for it to drift from;
 * what it can drift from is the wire contract it addresses. Every assertion
 * here therefore goes through the shipped constants and the real
 * `createRpcProxy`: the namespace comes from `DATA_SERVER_WIRE_PREFIX` and the
 * inbound allowlist from `DATA_CLIENT_PROTOCOL_METHODS`, so a rename on either
 * side reddens rather than being papered over by a literal.
 *
 * The server under test is a minimal stand-in rather than a `DataServer`,
 * deliberately: with a real server every assertion below would also pass on a
 * harness that mis-wired the namespace, because the real server's own
 * `createRpcProxy` call would supply the right one. `data-server.test.ts`
 * covers the real server against this harness; this file covers the harness.
 */

import { describe, expect, it } from 'vitest';
import { createRpcProxy, type Project, type TransferDiagnostic, type TransferElement } from '@hydranium/protocol';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type ProjectsChangedEvent,
   type TransferDocumentSavedEvent,
   type TransferDocumentUpdatedEvent
} from '@hydranium/protocol/data';
import { tick, waitFor } from '@hydranium/protocol/testing';
import type { MessageConnection } from 'vscode-jsonrpc/node';
import { makeDataServerHarness } from '../../src/testing/data-server-harness.js';

interface FakeTransfer extends TransferElement {
   readonly $type: 'TypeOne';
   readonly name: string;
}

const ROOT: FakeTransfer = { $type: 'TypeOne', name: 'one' };
const URI_ONE = 'file:///a.x';
const PROJECT: Project = { id: 'p-one', referenceName: 'one' };

/**
 * A stand-in for the server under test: it answers `getProjects` and can push
 * any of the three client events back, using the same `createRpcProxy` call
 * shape the real `DataServer` constructor uses.
 */
class FakeServer {
   readonly clientProxy: DataClientProtocol<FakeTransfer, TransferDiagnostic, Project>;
   projects: readonly Project[] = [PROJECT];

   constructor(
      readonly channel: MessageConnection,
      methodNamespace: string = DATA_SERVER_WIRE_PREFIX
   ) {
      this.clientProxy = createRpcProxy<DataClientProtocol<FakeTransfer, TransferDiagnostic, Project>, this>(channel, {
         methodNamespace,
         localTarget: this,
         // Selected out of the shipped list rather than written as a literal:
         // if `getProjects` ever leaves `DATA_SERVER_PROTOCOL_METHODS` the
         // filter yields nothing and the request tests below go red, instead of
         // passing against a name the contract no longer carries.
         localMethods: DATA_SERVER_PROTOCOL_METHODS.filter((name): name is 'getProjects' => name === 'getProjects')
      });
   }

   async getProjects(): Promise<readonly Project[]> {
      return this.projects;
   }
}

function updated(uri: string): TransferDocumentUpdatedEvent<FakeTransfer, TransferDiagnostic> {
   return { document: { uri, version: 1, root: ROOT, diagnostics: [] }, reason: 'changed', sourceClientId: 'client-a' };
}

function saved(uri: string): TransferDocumentSavedEvent<FakeTransfer, TransferDiagnostic> {
   return { document: { uri, version: 1, root: ROOT, diagnostics: [] }, sourceClientId: 'client-a' };
}

function projectsChanged(): ProjectsChangedEvent<Project> {
   return { project: PROJECT, reason: 'added' };
}

describe('makeDataServerHarness — subject construction', () => {
   it('invokes the server factory exactly once, synchronously, with the left side of the pair', () => {
      const calls: MessageConnection[] = [];
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({
         server: channel => {
            calls.push(channel);
            return new FakeServer(channel);
         }
      });

      // The factory runs during `makeDataServerHarness`, not on first use: a
      // lazily constructed server would miss notifications sent before the
      // first proxy call, and no assertion after the fact could tell.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe(harness.pair.left);
      expect(harness.server.channel).toBe(harness.pair.left);
      // The proxy addresses the OTHER side, or the pair short-circuits and the
      // transport is never exercised.
      expect(harness.pair.right).not.toBe(harness.pair.left);
      harness.dispose();
   });
});

describe('makeDataServerHarness — the seam', () => {
   it('reaches the server through the default wire namespace', async () => {
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({ server: channel => new FakeServer(channel) });

      await expect(harness.proxy.getProjects()).resolves.toEqual([PROJECT]);
      harness.dispose();
   });

   it('addresses a custom namespace when the server registers under one', async () => {
      const namespace = 'custom-namespace/';
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({
         server: channel => new FakeServer(channel, namespace),
         methodNamespace: namespace
      });

      await expect(harness.proxy.getProjects()).resolves.toEqual([PROJECT]);
      harness.dispose();
   });

   it('fails a request whose namespace the server never registered', async () => {
      // The mismatch case the option exists to avoid. Asserted because it is
      // the only thing separating "the namespace option is honoured" from "both
      // ends happen to default to the same string".
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({
         server: channel => new FakeServer(channel, 'server-namespace/'),
         methodNamespace: 'client-namespace/'
      });

      await expect(harness.proxy.getProjects()).rejects.toThrow(/[Uu]nhandled method/);
      harness.dispose();
   });
});

describe('makeDataServerHarness — the capture arrays', () => {
   it('captures all three client channels, in arrival order', async () => {
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({ server: channel => new FakeServer(channel) });

      harness.server.clientProxy.onDocumentUpdated(updated(URI_ONE));
      harness.server.clientProxy.onDocumentSaved(saved(URI_ONE));
      harness.server.clientProxy.onProjectsChanged(projectsChanged());

      // A notification has a whole socket round trip ahead of it, so nothing
      // about arrival is provable on the line after the send. Polled rather
      // than slept: a fixed yield is starved past its own deadline when the
      // whole workspace's suites run in parallel, which reddens a positive
      // wait for a reason the test is not about.
      await waitFor(() => harness.events.length + harness.saves.length + harness.projectsChanges.length === 3);

      expect(harness.events.map(event => event.document.uri)).toEqual([URI_ONE]);
      expect(harness.saves.map(event => event.document.uri)).toEqual([URI_ONE]);
      expect(harness.projectsChanges.map(event => [event.project.id, event.reason])).toEqual([['p-one', 'added']]);
      harness.dispose();
   });

   it('captures every name on the shipped client allowlist, not a hand-listed three', async () => {
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({ server: channel => new FakeServer(channel) });

      // Driven from the constant rather than from three named calls, so a
      // FOURTH client method added to the contract without a matching capture
      // channel reddens here. Sent as raw notifications because the point is
      // the wire name, and the default handlers only push.
      for (const method of DATA_CLIENT_PROTOCOL_METHODS) {
         harness.pair.left.sendNotification(`${DATA_SERVER_WIRE_PREFIX}${method}`, updated(URI_ONE));
      }
      const total = (): number => harness.events.length + harness.saves.length + harness.projectsChanges.length;
      await waitFor(() => total() === DATA_CLIENT_PROTOCOL_METHODS.length);

      expect(total()).toBe(DATA_CLIENT_PROTOCOL_METHODS.length);
      harness.dispose();
   });

   it('lets a client override REPLACE the default capture rather than supplement it', async () => {
      const overridden: string[] = [];
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({
         server: channel => new FakeServer(channel),
         client: { onDocumentUpdated: event => void overridden.push(event.document.uri) }
      });

      harness.server.clientProxy.onDocumentUpdated(updated(URI_ONE));
      harness.server.clientProxy.onDocumentSaved(saved(URI_ONE));
      // Poll the two POSITIVES, then yield once more so a wrongly-pushed
      // `events` entry has had its chance before the absence below is read.
      await waitFor(() => overridden.length === 1 && harness.saves.length === 1);
      await tick(4);

      expect(overridden).toEqual([URI_ONE]);
      // The documented consequence: `events` stays empty, so a suite that
      // overrides and then asserts on `events` is asserting on nothing. The
      // sibling channel is asserted non-empty in the same breath, which is what
      // makes this emptiness a statement about the override rather than about
      // an undelivered notification.
      expect(harness.events).toEqual([]);
      expect(harness.saves).toHaveLength(1);
      harness.dispose();
   });
});

describe('makeDataServerHarness — teardown', () => {
   it('releases the pair and tolerates a second dispose', async () => {
      const harness = makeDataServerHarness<FakeServer, FakeTransfer>({ server: channel => new FakeServer(channel) });
      await expect(harness.proxy.getProjects()).resolves.toEqual([PROJECT]);

      harness.dispose();
      harness.dispose();

      // The live request above is the control on this one: without it, a
      // rejection here would be consistent with a pair that never worked.
      await expect(harness.proxy.getProjects()).rejects.toThrow();
   });
});
