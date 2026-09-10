/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The client-side data-head doubles.
 *
 * Each case pins a property a consumer's own test relies on being true of the
 * double, so a change here that looks harmless cannot quietly invalidate a
 * suite that reads `port.connections.length` or an empty `updates`.
 */

import { describe, expect, it } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { DataClientProtocol } from '../../src/data/data-server-protocol';
import type { ProjectsChangedEvent, TransferDocumentUpdatedEvent } from '../../src/data/events';
import { defineMessage, describeError, resolve } from '../../src/messages/primitives';
import type { TransferElement } from '../../src/transfer-element';
import { makeCapturingDataClient, makeFakeDataPort } from '../../src/testing/data-doubles';

/** A stand-in declaration; the double is indifferent to which message arrives. */
const PROBE_FAILED = defineMessage('test/probe-failed', 'The probe failed: {detail}');

/** A neutral transfer root; nothing here parses or serialises it. */
interface ProbeElement extends TransferElement {
   $type: 'TypeOne';
}

/** A stand-in connection — the doubles never call a method on it. */
function connection(label: string): MessageConnection {
   return { label } as unknown as MessageConnection;
}

/** An `onDocumentUpdated` payload with the fields a subscriber reads. */
function updateEvent(uri: string, sourceClientId: string): TransferDocumentUpdatedEvent<ProbeElement> {
   return {
      document: { uri, version: 1, root: { $type: 'TypeOne' }, diagnostics: [] },
      sourceClientId,
      reason: 'changed'
   } as unknown as TransferDocumentUpdatedEvent<ProbeElement>;
}

describe('makeFakeDataPort', () => {
   it('records one connection per connect, in order', async () => {
      let generation = 0;
      const port = makeFakeDataPort({ connect: () => connection(`gen-${generation++}`) });

      const first = await port.connect();
      const second = await port.connect();

      // The count is the only observable that distinguishes "shared one
      // connection" from "opened a second", which is what a session's
      // memoisation and its reconnection path are both asserted through.
      expect(port.connections).toEqual([first, second]);
      expect(port.connections).toHaveLength(2);
      port.dispose();
   });

   it('defaults to a clientId that is none of the framework sentinels', () => {
      const port = makeFakeDataPort({ connect: () => connection('one') });

      // A double that defaulted to `'language-client'` or `'unknown'` would make
      // an echo-filtering test pass by colliding with the server's own sentinel.
      expect(['language-client', 'unknown', 'revert-on-close']).not.toContain(port.clientId);
      expect(makeFakeDataPort({ connect: () => connection('one'), clientId: 'chosen' }).clientId).toBe('chosen');
      port.dispose();
   });

   it('records every reportError with the resolved message beside the error', () => {
      const port = makeFakeDataPort({ connect: () => connection('one') });
      const failure = new Error('boom');
      const reported = resolve(PROBE_FAILED, { detail: describeError(failure) });

      port.reportError(failure, reported);

      // Both halves, and the code and params within the message: a double that
      // recorded only the error, or dropped `params`, would leave a consumer's
      // failure-path assertion unable to say WHICH failure it saw.
      expect(port.reported).toHaveLength(1);
      expect(port.reported[0].error).toBe(failure);
      expect(port.reported[0].message.code).toBe('test/probe-failed');
      expect(port.reported[0].message.params).toEqual({ detail: 'boom' });
      expect(port.reported[0].message.text).toBe('The probe failed: boom');
      port.dispose();
   });

   it('fires onDispose exactly when fireDispose is called', () => {
      const port = makeFakeDataPort({ connect: () => connection('one') });
      const fired: string[] = [];
      port.onDispose(() => fired.push('disposed'));

      // Asserting the BEFORE state too: an event that fired on subscription
      // would satisfy the after-assertion on its own.
      expect(fired).toEqual([]);
      port.fireDispose();
      expect(fired).toEqual(['disposed']);
      port.dispose();
   });

   it('does not record a connection when connect throws, and stays reusable', async () => {
      let attempt = 0;
      const port = makeFakeDataPort({
         connect: () => {
            attempt++;
            if (attempt === 1) {
               throw new Error('transport down');
            }
            return connection('recovered');
         }
      });

      await expect(port.connect()).rejects.toThrow('transport down');
      // A failed generation must not appear in the list, or a retry test reads
      // one connection where the consumer built two.
      expect(port.connections).toHaveLength(0);
      await port.connect();
      expect(port.connections).toHaveLength(1);
      port.dispose();
   });

   it('records the RESOLVED connection when connect is asynchronous, not the promise', async () => {
      const resolved = connection('async');
      const port = makeFakeDataPort({ connect: () => Promise.resolve(resolved) });

      const handed = await port.connect();

      // `connect` is declared to allow a promise, and the whole point of the
      // list is that a test can compare its entries against what the consumer
      // holds. A double that recorded the promise object would give a list
      // whose entries equal nothing the consumer ever saw — and the synchronous
      // case cannot tell the two apart, which is why this case exists.
      expect(handed).toBe(resolved);
      expect(port.connections).toEqual([resolved]);
      port.dispose();
   });

   it('does not record a connection when an asynchronous connect REJECTS', async () => {
      let attempt = 0;
      const port = makeFakeDataPort({
         connect: () => {
            attempt++;
            return attempt === 1 ? Promise.reject(new Error('handshake refused')) : Promise.resolve(connection('recovered'));
         }
      });

      await expect(port.connect()).rejects.toThrow('handshake refused');
      // Distinct from the synchronous throw above: there the failure happens
      // before the recording line is reached at all, so that case passes even
      // for a double that never awaits. This one does not.
      expect(port.connections).toHaveLength(0);
      await port.connect();
      expect(port.connections).toHaveLength(1);
      port.dispose();
   });
});

describe('makeCapturingDataClient', () => {
   it('captures all three channels independently', () => {
      const capturing = makeCapturingDataClient<ProbeElement>();

      capturing.client.onDocumentUpdated(updateEvent('file:///a.x', 'client-a'));
      capturing.client.onDocumentSaved(updateEvent('file:///a.x', 'client-a'));
      capturing.client.onProjectsChanged({ projects: [], reason: 'added' } as unknown as ProjectsChangedEvent);

      // One event per channel, so a double that pushed everything into one
      // array — or dropped the two a suite does not read — is visible here.
      expect(capturing.updates).toHaveLength(1);
      expect(capturing.saves).toHaveLength(1);
      expect(capturing.projectsChanges).toHaveLength(1);
      expect(capturing.updates[0].sourceClientId).toBe('client-a');
   });

   it('lets an override REPLACE a channel, leaving its array empty', () => {
      const seen: string[] = [];
      const overrides: Partial<DataClientProtocol<ProbeElement>> = {
         onDocumentUpdated: event => seen.push(event.sourceClientId)
      };
      const capturing = makeCapturingDataClient<ProbeElement>(overrides);

      capturing.client.onDocumentUpdated(updateEvent('file:///a.x', 'client-b'));
      capturing.client.onDocumentSaved(updateEvent('file:///a.x', 'client-b'));

      // Replace rather than supplement, which is what makes an override usable
      // as a barrier (throwing, counting differently) and not merely as a spy.
      expect(seen).toEqual(['client-b']);
      expect(capturing.updates).toEqual([]);
      // The channels that were NOT overridden keep recording.
      expect(capturing.saves).toHaveLength(1);
   });
});
