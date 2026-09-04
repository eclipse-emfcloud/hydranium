/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The in-memory LSP transport primitive, tested without any Langium services:
 * `serverConnection.sendDiagnostics` writes straight onto the wire, so the
 * capture and the per-URI waiters can be exercised on their own.
 *
 * What these cases pin is that both are served from ONE `onNotification`
 * registration. `vscode-jsonrpc` keeps a single handler per notification type,
 * so splitting them makes arming a wait displace the always-on capture, and
 * disposing that wait leaves no handler at all — the capture then reads empty in
 * every suite that also awaits a publish, which is every suite that drives an
 * edit.
 */

import { describe, expect, it } from 'vitest';
import { waitFor } from '@hydranium/protocol/testing';
import type { WorkspaceEdit } from 'vscode-languageserver-protocol';
import { makeLspServerConnection } from '../../src/testing/node/lsp-server-connection.js';

const URI_A = 'file:///a.x';
const URI_B = 'file:///x.other';
/** Any range — these cases distinguish publishes by `message`, never by position. */
const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

/**
 * A `documentChanges`-form edit addressing one URI, shaped as
 * `applyEditToLanguageClient` shapes its push (a versioned identifier plus a
 * text-edit list).
 */
function replaceIn(uri: string, newText: string): WorkspaceEdit {
   return { documentChanges: [{ textDocument: { uri, version: null }, edits: [{ range: RANGE, newText }] }] };
}

/**
 * A wire whose server side is listening. `sendDiagnostics` is a notification
 * and goes out on an unlistened connection, but a server→client REQUEST throws
 * `Call listen() first` — in production `startLanguageServer` makes that call,
 * and these cases drive the transport with no services attached.
 */
function listeningWire(): ReturnType<typeof makeLspServerConnection> {
   const wire = makeLspServerConnection();
   wire.serverConnection.listen();
   return wire;
}

describe('makeLspServerConnection diagnostics', () => {
   it('records a publish in the capture', async () => {
      const wire = makeLspServerConnection();
      try {
         const armed = wire.nextDiagnostics(URI_A);
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [] });
         await armed;
         expect(wire.diagnostics.map(published => published.uri)).toEqual([URI_A]);
      } finally {
         wire.dispose();
      }
   });

   it('keeps capturing after a wait has resolved', async () => {
      const wire = makeLspServerConnection();
      try {
         const armed = wire.nextDiagnostics(URI_A);
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [] });
         await armed;

         // A resolved waiter must remove only itself, never dispose the ONE
         // handler — that loses every later publish, capture and waits alike.
         await wire.serverConnection.sendDiagnostics({ uri: URI_B, diagnostics: [] });
         const second = wire.nextDiagnostics(URI_A);
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [] });
         await second;

         expect(wire.diagnostics.map(published => published.uri)).toEqual([URI_A, URI_B, URI_A]);
      } finally {
         wire.dispose();
      }
   });

   it('serves concurrent waiters on different URIs from one subscription', async () => {
      const wire = makeLspServerConnection();
      try {
         const forA = wire.nextDiagnostics(URI_A);
         const forB = wire.nextDiagnostics(URI_B);

         await wire.serverConnection.sendDiagnostics({ uri: URI_B, diagnostics: [] });
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [] });

         // Both resolve, and neither displaced the other — the failure mode if
         // each waiter owned its own `onNotification` registration.
         await expect(forA).resolves.toEqual([]);
         await expect(forB).resolves.toEqual([]);
         expect(wire.diagnostics).toHaveLength(2);
      } finally {
         wire.dispose();
      }
   });

   it('resolves from the capture when { fromIndex } names a publish that already arrived', async () => {
      const wire = makeLspServerConnection();
      try {
         const before = wire.diagnostics.length;
         // The publish happens with NO waiter armed — the case a bare
         // `nextDiagnostics` cannot serve, because a waiter only ever sees
         // publishes that come after it.
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [{ message: 'boom', range: RANGE }] });
         // `sendDiagnostics` resolves once WRITTEN, so poll the capture rather
         // than assume the notification has been received.
         await waitFor(() => wire.diagnostics.length > before);

         const replayed = await wire.nextDiagnostics(URI_A, { fromIndex: before, timeoutMs: 50 });
         expect(replayed.map(diagnostic => diagnostic.message)).toEqual(['boom']);
      } finally {
         wire.dispose();
      }
   });

   it('ignores a publish that predates { fromIndex } and waits for the next one', async () => {
      const wire = makeLspServerConnection();
      try {
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [{ message: 'stale', range: RANGE }] });
         await waitFor(() => wire.diagnostics.length > 0);

         // Baseline recorded AFTER the stale publish is in the capture: the
         // index is what makes the earlier entry unreachable, so a `fromIndex`
         // that were ignored would answer 'stale' here.
         const after = wire.diagnostics.length;
         const armed = wire.nextDiagnostics(URI_A, { fromIndex: after });
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [{ message: 'fresh', range: RANGE }] });

         expect((await armed).map(diagnostic => diagnostic.message)).toEqual(['fresh']);
      } finally {
         wire.dispose();
      }
   });

   it('rejects a wait that never sees its URI, leaving the capture live', async () => {
      const wire = makeLspServerConnection();
      try {
         const doomed = wire.nextDiagnostics(URI_A, 50);
         await wire.serverConnection.sendDiagnostics({ uri: URI_B, diagnostics: [] });
         await expect(doomed).rejects.toThrow(/Timed out waiting for diagnostics/);

         // A timed-out waiter must remove only itself: the non-matching publish
         // it ignored is still captured, and both the capture and a fresh waiter
         // still work afterwards. Awaiting the fresh waiter is also what gates
         // delivery — `sendDiagnostics` resolves once WRITTEN, not once received.
         const afterTimeout = wire.nextDiagnostics(URI_A);
         await wire.serverConnection.sendDiagnostics({ uri: URI_A, diagnostics: [] });
         await afterTimeout;
         expect(wire.diagnostics.map(published => published.uri)).toEqual([URI_B, URI_A]);
      } finally {
         wire.dispose();
      }
   });
});

/**
 * The EGRESS direction, exercised through the same API the framework's
 * `applyEditToLanguageClient` uses — `serverConnection.workspace.applyEdit` —
 * so the request crosses the real wire and the client's answer comes back to
 * the server. Without a handler registered the server's request would fail as
 * an unhandled method, which is what made this path unobservable.
 */
describe('makeLspServerConnection applyEdit', () => {
   it('captures a push, derives its URIs and text, and answers applied by default', async () => {
      const wire = listeningWire();
      try {
         const result = await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'renamed'));

         expect(result).toEqual({ applied: true });
         expect(wire.appliedEdits).toHaveLength(1);
         expect(wire.appliedEdits[0].uris).toEqual([URI_A]);
         expect(wire.appliedEdits[0].text).toBe('renamed');
         // The raw request stays available: the version is what lets a client
         // reject a push its buffer has outrun.
         expect(wire.appliedEdits[0].params.edit.documentChanges).toHaveLength(1);
      } finally {
         wire.dispose();
      }
   });

   it('derives both URIs of a rename and the keys of a changes-form edit', async () => {
      const wire = listeningWire();
      try {
         await wire.serverConnection.workspace.applyEdit({
            documentChanges: [{ kind: 'rename', oldUri: URI_A, newUri: URI_B }]
         });
         await wire.serverConnection.workspace.applyEdit({ changes: { [URI_B]: [{ range: RANGE, newText: 'via-changes' }] } });

         expect(wire.appliedEdits.map(edit => edit.uris)).toEqual([[URI_A, URI_B], [URI_B]]);
         expect(wire.appliedEdits.map(edit => edit.text)).toEqual(['', 'via-changes']);
      } finally {
         wire.dispose();
      }
   });

   it('lets a handler reject the edit, and still captures the push', async () => {
      const wire = listeningWire();
      try {
         wire.setApplyEditHandler(() => ({ applied: false, failureReason: 'buffer outran the push' }));

         const result = await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'stale'));

         // The rejection branch the framework invalidates its text shadow on.
         expect(result).toEqual({ applied: false, failureReason: 'buffer outran the push' });
         // Recorded regardless: the SEND is what an egress assertion is about.
         expect(wire.appliedEdits.map(edit => edit.text)).toEqual(['stale']);
      } finally {
         wire.dispose();
      }
   });

   it('resolves from the capture when { fromIndex } names a push that already arrived', async () => {
      const wire = listeningWire();
      try {
         const before = wire.appliedEdits.length;
         // The push happens with NO waiter armed — the case a bare
         // `nextAppliedEdit` cannot serve.
         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'early'));

         const replayed = await wire.nextAppliedEdit(URI_A, { fromIndex: before, timeoutMs: 50 });
         expect(replayed.text).toBe('early');
      } finally {
         wire.dispose();
      }
   });

   it('skips a push that addresses the URI but fails { match }, and waits for the next', async () => {
      const wire = listeningWire();
      try {
         const armed = wire.nextAppliedEdit(URI_A, { match: edit => edit.text.includes('wanted') });

         // A coalesced sync carrying none of the text under test. A URI match
         // alone would resolve on this one.
         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'unrelated'));
         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'the wanted fragment'));

         expect((await armed).text).toBe('the wanted fragment');
         expect(wire.appliedEdits).toHaveLength(2);
      } finally {
         wire.dispose();
      }
   });

   it('keeps capturing after a wait has resolved, and serves concurrent waiters from one handler', async () => {
      const wire = listeningWire();
      try {
         const forA = wire.nextAppliedEdit(URI_A);
         const forB = wire.nextAppliedEdit(URI_B);

         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_B, 'b'));
         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'a'));
         await expect(forA).resolves.toMatchObject({ text: 'a' });
         await expect(forB).resolves.toMatchObject({ text: 'b' });

         // A resolved waiter must remove only itself, never dispose the ONE
         // request handler — `vscode-jsonrpc` keeps a single handler per request
         // type, so losing it leaves every later `applyEdit` unanswered.
         const later = wire.nextAppliedEdit(URI_A);
         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'again'));
         await later;
         expect(wire.appliedEdits.map(edit => edit.text)).toEqual(['b', 'a', 'again']);
      } finally {
         wire.dispose();
      }
   });

   it('rejects a wait that never sees its URI, leaving the capture and later waits live', async () => {
      const wire = listeningWire();
      try {
         const doomed = wire.nextAppliedEdit(URI_A, 50);
         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_B, 'b'));
         await expect(doomed).rejects.toThrow(/Timed out waiting for a workspace\/applyEdit/);

         const afterTimeout = wire.nextAppliedEdit(URI_A);
         await wire.serverConnection.workspace.applyEdit(replaceIn(URI_A, 'a'));
         await afterTimeout;
         expect(wire.appliedEdits.map(edit => edit.uris[0])).toEqual([URI_B, URI_A]);
      } finally {
         wire.dispose();
      }
   });
});
