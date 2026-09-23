/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Several participants over one data connection.
 *
 * The assertions worth having read the clientId the SERVER received, not the
 * one the session reports: the server keys its holds and watches per
 * `(uri, clientId)`, so a stamp that never reaches the wire buys nothing.
 *
 * Every close asserted here is fired WITHOUT being awaited — a `Disposable`
 * cannot be, and a close issued after its caller is gone has nobody to hand a
 * promise to — so arrival is polled, never timed. A fixed delay buys no
 * margin: the crossing costs event-loop turns and no wall time, so the delay
 * expires on a clock the delivery does not run on, and any stall inside it
 * fails the assertion. `tick` stays right for the assertions that are an
 * ABSENCE, which no amount of polling can establish.
 */

import { describe, expect, it } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import { FRAMEWORK_CLIENT_IDS } from '../../src/client-ids';
import { DataConnection, DataConnectionWithEvents } from '../../src/client/data-connection';
import { DataEvents } from '../../src/client/data-events';
import { DATA_SERVER_WIRE_PREFIX } from '../../src/data';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { tick, waitFor } from '../../src/testing';
import { type FakeDataPort, makeFakeDataPort } from '../../src/testing/data-doubles';
import { makeDuplexConnectionPair } from '../../src/testing/node';
import type { TransferElement } from '../../src/transfer-element';

interface ProbeElement extends TransferElement {
   $type: 'TypeOne';
}

interface ServerCall {
   readonly method: 'open' | 'watch' | 'close' | 'update';
   readonly uri: string;
   readonly clientId: string;
}

const URI_A = 'file:///a.x';
const URI_B = 'file:///b.x';
const URI_C = 'file:///c.x';

function document(uri: string): unknown {
   return { uri, version: 1, root: { $type: 'TypeOne' }, diagnostics: [] };
}

/**
 * Knobs a lifecycle test needs and a plain echo cannot give it.
 *
 * `watchGate` holds the WATCH handler open, which is what makes the window
 * inside `openDocument` — between the open landing and the URI being tracked —
 * addressable at all; without it the window is microtasks wide and a test of it
 * would be a timing bet. `failClose` makes a close reject, which is the only way
 * to observe whether a failed close stays tracked for retry.
 */
interface ServerBehaviour {
   readonly watchGate?: Promise<void>;
   /** Mutable, so a test can refuse a close and then let a later retry through. */
   failClose?: boolean;
   /**
    * Make `watchModelDocument` reject. Mutable and read per call, so a test can
    * let one open succeed and fail the next — the shape that decides whether a
    * rollback closes a hold this attempt took or one that predated it.
    */
   failWatch?: boolean;
   /**
    * Reject only the next `n` watch calls, counting down as they arrive. A
    * boolean cannot express the overlapping case: both opens are in flight
    * before either handler runs, so flipping a flag between the two calls
    * changes it long before the first one reads it.
    */
   failNextWatches?: number;
   /**
    * Reject `openModelDocument` from the given call number onward (1-based), so
    * a test can let one open take its hold and fail the next outright. An open
    * that fails has no hold of its own and no rollback path, which is what makes
    * it the peer a deferring rollback cannot rely on.
    */
   failOpenFromCall?: number;
   /**
    * Holds the OPEN handler open for the calls {@link failOpenFromCall} selects.
    * Without it the second open rejects before the first open's watch has even
    * been issued, so the two never actually overlap and the test proves nothing
    * about concurrency — it just happens to resolve in the safe order.
    */
   readonly openGate?: Promise<void>;
}

/** Bind a server that records the `(method, uri, clientId)` of every call. */
function recordingServer(connection: MessageConnection, behaviour: ServerBehaviour = {}): ServerCall[] {
   const calls: ServerCall[] = [];
   const record =
      (method: ServerCall['method']) =>
      async (args: { uri: string; clientId: string }): Promise<unknown> => {
         calls.push({ method, uri: args.uri, clientId: args.clientId });
         return document(args.uri);
      };
   let openCalls = 0;
   const target = {
      waitForReady: async (): Promise<void> => undefined,
      openModelDocument: async (args: { uri: string; clientId: string }): Promise<unknown> => {
         openCalls += 1;
         if (behaviour.failOpenFromCall !== undefined && openCalls >= behaviour.failOpenFromCall) {
            await behaviour.openGate;
            throw new Error('open refused');
         }
         return record('open')(args);
      },
      watchModelDocument: async (args: { uri: string; clientId: string }): Promise<unknown> => {
         await behaviour.watchGate;
         const result = await record('watch')(args);
         if (behaviour.failNextWatches !== undefined && behaviour.failNextWatches > 0) {
            behaviour.failNextWatches -= 1;
            throw new Error('watch refused');
         }
         if (behaviour.failWatch) {
            throw new Error('watch refused');
         }
         return result;
      },
      closeModelDocument: async (args: { uri: string; clientId: string }): Promise<unknown> => {
         const result = await record('close')(args);
         if (behaviour.failClose) {
            throw new Error('close refused');
         }
         return result;
      },
      updateModelDocument: record('update')
   };
   bindRpcMethods(
      connection,
      target,
      ['waitForReady', 'openModelDocument', 'watchModelDocument', 'closeModelDocument', 'updateModelDocument'],
      {
         methodNamespace: DATA_SERVER_WIRE_PREFIX
      }
   );
   return calls;
}

function harness(behaviour: ServerBehaviour = {}): {
   connection: DataConnection<ProbeElement>;
   calls: ServerCall[];
   port: FakeDataPort;
   dispose(): void;
} {
   const pair = makeDuplexConnectionPair();
   const calls = recordingServer(pair.left, behaviour);
   const port = makeFakeDataPort({ connect: () => pair.right });
   const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>());
   return {
      connection,
      calls,
      port,
      dispose: () => {
         connection.dispose();
         pair.dispose();
      }
   };
}

const opens = (calls: readonly ServerCall[]): ServerCall[] => calls.filter(call => call.method === 'open');
const closes = (calls: readonly ServerCall[]): ServerCall[] => calls.filter(call => call.method === 'close');

describe('DataConnection lifecycle hooks', () => {
   it('reports connecting then ready around the two waits', async () => {
      const pair = makeDuplexConnectionPair();
      recordingServer(pair.left);
      const port = makeFakeDataPort({ connect: () => pair.right });
      const steps: string[] = [];
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>(), {
         onConnecting: () => steps.push('connecting'),
         onReady: () => steps.push('ready'),
         onFailed: () => steps.push('failed')
      });
      try {
         await connection.createSession('panel').openDocument({ uri: URI_A });
         expect(steps).toEqual(['connecting', 'ready']);
      } finally {
         connection.dispose();
         pair.dispose();
      }
   });

   it('reports a failure instead of readiness when the transport never opens', async () => {
      const steps: string[] = [];
      const port = makeFakeDataPort({ connect: () => Promise.reject(new Error('no transport')) });
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>(), {
         onConnecting: () => steps.push('connecting'),
         onReady: () => steps.push('ready'),
         onFailed: () => steps.push('failed')
      });
      try {
         await expect(connection.connected()).rejects.toThrow('no transport');
         expect(steps).toEqual(['connecting', 'failed']);
      } finally {
         connection.dispose();
      }
   });
});

describe('DataConnection sessions', () => {
   it('stamps each session its own clientId on the wire', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         const tree = connection.createSession('tree');

         await panel.openDocument({ uri: URI_A });
         await tree.openDocument({ uri: URI_A });

         // One connection, one document, two holders — which is the whole point
         // of the split. A session taking its identity from the transport would
         // send 'panel' twice and the server would see a single holder.
         expect(opens(calls).map(call => call.clientId)).toEqual(['panel', 'tree']);
      } finally {
         dispose();
      }
   });

   it('stamps the session clientId on a write the caller did not supply one for', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const tree = connection.createSession('tree');
         await tree.updateDocument({ uri: URI_A, model: { $type: 'TypeOne' }, basedOn: 'anything' });

         expect(calls.filter(call => call.method === 'update')).toEqual([{ method: 'update', uri: URI_A, clientId: 'tree' }]);
      } finally {
         dispose();
      }
   });

   it('recognises only its own echo', () => {
      const { connection, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         const tree = connection.createSession('tree');

         // Sharing one identity would make both answer the same way for both
         // ids, so the disagreement is the property.
         expect(panel.isOwnEcho('panel')).toBe(true);
         expect(panel.isOwnEcho('tree')).toBe(false);
         expect(tree.isOwnEcho('tree')).toBe(true);
      } finally {
         dispose();
      }
   });

   it('releases only the disposing session holds and leaves the connection usable', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         const tree = connection.createSession('tree');
         await panel.openDocument({ uri: URI_A });
         await tree.openDocument({ uri: URI_B });

         panel.dispose();
         await waitFor(() => closes(calls).length > 0);

         // A round trip AFTER the close landed, so a wrongly-issued close for
         // the other session has had a full exchange to arrive before the
         // count is read — and it proves the connection outlives its session.
         await tree.openDocument({ uri: URI_C });

         expect(closes(calls)).toEqual([{ method: 'close', uri: URI_A, clientId: 'panel' }]);
         expect(opens(calls).map(call => call.uri)).toEqual([URI_A, URI_B, URI_C]);
      } finally {
         dispose();
      }
   });

   it('detaches its sessions on dispose rather than closing over a dying wire', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         await panel.openDocument({ uri: URI_A });

         connection.dispose();
         await tick();

         // The server drains every hold on a connection it sees close, so a
         // close here would travel over the connection being disposed. The
         // session-dispose case above is what proves closes are sent when the
         // wire survives, so the two together discriminate.
         expect(closes(calls)).toEqual([]);
         await expect(panel.openDocument({ uri: URI_C })).rejects.toThrow('DataSession is disposed');
      } finally {
         dispose();
      }
   });

   it('refuses a clientId the framework reserves for its own broadcasts', () => {
      const { connection, dispose } = harness();
      try {
         // A session under one of these would match the framework's OWN
         // broadcasts as its own echoes and drop them, so the document silently
         // stops following — indistinguishable from a dead connection. Every
         // reserved id is checked rather than a representative one, since the
         // guard is a list membership and a single case passes for a hardcoded
         // comparison against that one value.
         for (const reserved of FRAMEWORK_CLIENT_IDS) {
            expect(() => connection.createSession(reserved)).toThrow(reserved);
         }
         expect(() => connection.createSession('panel')).not.toThrow();
      } finally {
         dispose();
      }
   });

   it('closes a hold whose open resolved after its session was disposed', async () => {
      let openTheGate!: () => void;
      const watchGate = new Promise<void>(resolve => {
         openTheGate = resolve;
      });
      const { connection, calls, dispose } = harness({ watchGate });
      try {
         const panel = connection.createSession('panel');
         // Deliberately NOT awaited: a host firing its open from a synchronous
         // init is what makes this window reachable at all.
         const opening = panel.openDocument({ uri: URI_A });
         await waitFor(() => opens(calls).length === 1);

         panel.dispose();
         // The hold exists on the server and in no set the session can read, so
         // dispose has nothing to close. This assertion is the defect: without
         // the check in openDocument it stays true forever.
         expect(closes(calls)).toEqual([]);

         openTheGate();
         await opening;
         await waitFor(() => closes(calls).length === 1, { message: 'the raced-open hold was never closed' });

         expect(closes(calls)).toEqual([{ method: 'close', uri: URI_A, clientId: 'panel' }]);
      } finally {
         dispose();
      }
   });

   it('sends no close when that same window ends in detach rather than dispose', async () => {
      let openTheGate!: () => void;
      const watchGate = new Promise<void>(resolve => {
         openTheGate = resolve;
      });
      const { connection, calls, dispose } = harness({ watchGate });
      try {
         const panel = connection.createSession('panel');
         const opening = panel.openDocument({ uri: URI_A });
         await waitFor(() => opens(calls).length === 1);

         // detach() is public and means "send nothing" — the server drains every
         // hold on a connection it sees close. Honouring that must not depend on
         // the connection already being dead, which is why this is a separate
         // flag rather than a close that happens to fail.
         panel.detach();

         openTheGate();
         await opening;
         await tick();

         expect(closes(calls)).toEqual([]);
      } finally {
         dispose();
      }
   });

   it('keeps a failed close tracked, so dispose retries it', async () => {
      const { connection, calls, dispose } = harness({ failClose: true });
      try {
         const panel = connection.createSession('panel');
         await panel.openDocument({ uri: URI_A });

         await expect(panel.closeDocument({ uri: URI_A })).rejects.toThrow('close refused');
         expect(closes(calls)).toHaveLength(1);

         // Untracking before the await would have dropped the URI on the way
         // out, leaving the hold alive on the server with nothing left to
         // release it.
         panel.dispose();
         await waitFor(() => closes(calls).length === 2, { message: 'dispose did not retry the failed close' });
      } finally {
         dispose();
      }
   });

   it('refuses a clientId a live participant already holds, and frees it again on dispose', () => {
      const { connection, dispose } = harness();
      try {
         const first = connection.createSession('form-editor');

         // Per-document membership is a SET of client ids, so a second
         // participant under this id would take no second hold: the first close
         // releases the only one and the survivor stops receiving updates for a
         // document it is still showing. The id is asserted in the message
         // because that is the whole diagnostic value — the caller minted it and
         // has to recognise which one collided.
         expect(() => connection.createSession('form-editor')).toThrow('form-editor');

         // A neighbouring id is unaffected, which is what separates "rejects a
         // duplicate" from "rejects a second session".
         expect(() => connection.createSession('tree')).not.toThrow();

         // The identity belongs to a LIVE participant, not to the connection
         // forever: a widget closing and reopening under a recycled id must not
         // be refused. This also pins that dispose releases the session from the
         // connection, without which the guard would leak ids.
         first.dispose();
         expect(() => connection.createSession('form-editor')).not.toThrow();
      } finally {
         dispose();
      }
   });

   it('surfaces a failure through the port, for every participant', () => {
      const { connection, port, dispose } = harness();
      try {
         const failure = new Error('boom');
         const reported = { code: 'test/failed', text: 'boom', params: {} };

         connection.reportError(failure, reported);

         // Through the PORT, not swallowed and not a channel of its own: the
         // port is the host's one sink, so a panel and a tree on the same
         // connection report the same way without being handed the transport.
         expect(port.reported).toEqual([{ error: failure, message: reported }]);
      } finally {
         dispose();
      }
   });
});

/**
 * An open that fails halfway.
 *
 * `openDocument` takes a server-side hold and then starts the watch, so a watch
 * that rejects leaves the hold standing with nothing tracking it: the URI is
 * registered only once BOTH calls return, so `dispose` cannot release what it
 * cannot see. The connection's own close-time cleanup eventually collects it,
 * which is no help to a panel disposed while its peers keep the connection
 * open — the hold then outlives the participant for as long as the connection
 * lives.
 *
 * The rollback is therefore part of the open, not of disposal, and the
 * assertions are about what the SERVER received: a hold it never releases is
 * the failure, and only the wire shows that.
 */
describe('DataSession.openDocument when the watch fails', () => {
   it('closes the hold the failed open took, and rejects', async () => {
      const { connection, calls, dispose } = harness({ failWatch: true });
      try {
         const panel = connection.createSession('panel');

         await expect(panel.openDocument({ uri: URI_A })).rejects.toThrow(/watch refused/);
         await waitFor(() => closes(calls).length > 0);

         expect(closes(calls)).toEqual([{ method: 'close', uri: URI_A, clientId: 'panel' }]);
      } finally {
         dispose();
      }
   });

   it('leaves a second session on the same connection holding its own document', async () => {
      const { connection, calls, dispose } = harness({ failWatch: true });
      try {
         const tree = connection.createSession('tree');
         const panel = connection.createSession('panel');

         await expect(panel.openDocument({ uri: URI_A })).rejects.toThrow(/watch refused/);
         await waitFor(() => closes(calls).length > 0);

         // The rollback is scoped to the failing session's own (uri, clientId).
         expect(closes(calls).every(call => call.clientId === 'panel')).toBe(true);
         expect(closes(calls).some(call => call.clientId === 'tree')).toBe(false);
         // And the connection is still usable by the session that did not fail.
         expect(tree.isOwnEcho('tree')).toBe(true);
      } finally {
         dispose();
      }
   });

   it('keeps the URI tracked for dispose to retry when the rollback close also fails', async () => {
      const { connection, calls, dispose } = harness({ failWatch: true, failClose: true });
      try {
         const panel = connection.createSession('panel');
         await expect(panel.openDocument({ uri: URI_A })).rejects.toThrow(/watch refused/);
         await waitFor(() => closes(calls).length > 0);
         const afterRollback = closes(calls).length;

         // A rollback whose close was refused must not drop the URI: the hold is
         // still there, and disposal is the only thing left that would release it.
         panel.dispose();
         await waitFor(() => closes(calls).length > afterRollback);

         expect(closes(calls).length).toBeGreaterThan(afterRollback);
      } finally {
         dispose();
      }
   });

   it('does not strand the URI in a set nothing reads when the session is already disposed', async () => {
      // The rollback close can land after a `dispose` that has already drained
      // `openUris`. Tracking the URI then reads as handled and is not: nothing
      // will look at that set again, so the entry is a leak wearing the shape of
      // a retry. The honest outcome is that the server's connection-close
      // cleanup owns it, and the session says so by not tracking it.
      const { connection, calls, dispose } = harness({ failWatch: true, failClose: true });
      try {
         const panel = connection.createSession('panel');
         const opening = panel.openDocument({ uri: URI_A });
         panel.dispose();
         await expect(opening).rejects.toThrow(/watch refused/);
         await tick(5);

         // The hold is the thing that matters, so the release must have been
         // ATTEMPTED on the wire — a session that only tidied its own bookkeeping
         // would have an empty `openUris` while leaving the server holding it.
         expect(closes(calls)).toContainEqual({ method: 'close', uri: URI_A, clientId: 'panel' });
         const tracked = panel as unknown as { openUris: Set<string> };
         expect([...tracked.openUris]).toEqual([]);
      } finally {
         dispose();
      }
   });

   it('hands a hold it could not release to the connection, which retries it', async () => {
      // A disposed session has drained and will not look again, so a rollback
      // close that is REFUSED has nobody left to answer for the hold. Leaving it
      // to the server's connection-close cleanup means it survives for as long as
      // the connection does, which on a shared connection is the whole session of
      // every other participant. The connection outlives the session and owns the
      // wire, so it is what can still release it.
      const behaviour: ServerBehaviour = { failWatch: true, failClose: true };
      const { connection, calls, dispose } = harness(behaviour);
      try {
         const panel = connection.createSession('panel');
         const opening = panel.openDocument({ uri: URI_A });
         panel.dispose();
         await expect(opening).rejects.toThrow(/watch refused/);
         await waitFor(() => closes(calls).length > 0);
         const attempts = closes(calls).filter(call => call.uri === URI_A).length;

         // Whatever refused the close has passed. Any later activity on the
         // shared connection is an opportunity to retry.
         behaviour.failClose = false;
         behaviour.failWatch = false;
         const tree = connection.createSession('tree');
         await tree.openDocument({ uri: URI_B });
         await waitFor(() => closes(calls).filter(call => call.uri === URI_A).length > attempts);

         expect(closes(calls).filter(call => call.uri === URI_A && call.clientId === 'panel').length).toBeGreaterThan(attempts);
      } finally {
         dispose();
      }
   });

   it('refuses to mint a session under an id that still owes an orphaned hold', async () => {
      // The pending retry closes `(uri, clientId)`, and the server keys one hold
      // per that pair. Handing the same id to a new participant lets that close
      // land on ITS hold instead — the document goes out from under a session
      // that opened it successfully, and the close that did it was issued on
      // behalf of a participant already gone.
      const behaviour: ServerBehaviour = { failWatch: true, failClose: true };
      const { connection, calls, dispose } = harness(behaviour);
      try {
         const panel = connection.createSession('panel');
         const opening = panel.openDocument({ uri: URI_A });
         panel.dispose();
         await expect(opening).rejects.toThrow(/watch refused/);
         await waitFor(() => closes(calls).length > 0);

         expect(() => connection.createSession('panel')).toThrow(/unreleased hold/);

         // The reservation lasts exactly as long as the debt: once the release
         // lands, nothing is left that could close on the id's behalf.
         behaviour.failClose = false;
         behaviour.failWatch = false;
         const tree = connection.createSession('tree');
         await tree.openDocument({ uri: URI_B });
         await waitFor(() => {
            try {
               connection.createSession('panel').dispose();
               return true;
            } catch {
               return false;
            }
         });
      } finally {
         dispose();
      }
   });

   it('releases the hold when a concurrent open of the same URI fails before taking one', async () => {
      // The deferring rollback assumes the peer it defers to will either keep the
      // hold or release it. An open that FAILS does neither: it never took a hold
      // of its own, so it has nothing to roll back, and the hold the first open
      // took is left with nobody who believes they own it.
      let releaseSecondOpen = (): void => undefined;
      const openGate = new Promise<void>(resolve => {
         releaseSecondOpen = resolve;
      });
      const behaviour: ServerBehaviour = { failNextWatches: 1, failOpenFromCall: 2, openGate };
      const pair = makeDuplexConnectionPair();
      const calls = recordingServer(pair.left, behaviour);
      const port = makeFakeDataPort({ connect: () => pair.right });
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>());
      try {
         const panel = connection.createSession('panel');
         const first = panel.openDocument({ uri: URI_A });
         const second = panel.openDocument({ uri: URI_A });

         // The first open's watch fails while the second is STILL in flight, so
         // the first sees a peer it could defer to. Only then does that peer fail.
         await expect(first).rejects.toThrow(/watch refused/);
         releaseSecondOpen();
         await expect(second).rejects.toThrow(/open refused/);
         await tick(5);

         expect(closes(calls)).toEqual([{ method: 'close', uri: URI_A, clientId: 'panel' }]);
      } finally {
         connection.dispose();
         pair.dispose();
      }
   });

   it('does not close a hold a concurrent open of the same URI is establishing', async () => {
      // Two opens of one URI overlap, and both read "not held yet" on the way
      // in. The server keys a hold per `(uri, clientId)`, so a rollback issued
      // by the failing one releases the hold the succeeding one is relying on —
      // and the document goes out from under a caller whose open returned fine.
      const behaviour: ServerBehaviour = {};
      const pair = makeDuplexConnectionPair();
      const calls = recordingServer(pair.left, behaviour);
      const port = makeFakeDataPort({ connect: () => pair.right });
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>());
      try {
         const panel = connection.createSession('panel');
         // Both launched before either is awaited, so both read "not held yet".
         // Only the first watch to arrive rejects, which is the failing open's.
         behaviour.failNextWatches = 1;
         const failing = panel.openDocument({ uri: URI_A });
         const succeeding = panel.openDocument({ uri: URI_A });

         await expect(failing).rejects.toThrow(/watch refused/);
         await succeeding;
         await tick(5);

         expect(closes(calls)).toEqual([]);
      } finally {
         connection.dispose();
         pair.dispose();
      }
   });

   it('does not close a hold the session already had when a repeat open fails', async () => {
      const behaviour: ServerBehaviour = {};
      const pair = makeDuplexConnectionPair();
      const calls = recordingServer(pair.left, behaviour);
      const port = makeFakeDataPort({ connect: () => pair.right });
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>());
      try {
         const panel = connection.createSession('panel');
         // First open succeeds, so the session holds the URI for real.
         await panel.openDocument({ uri: URI_A });

         // A second open of the SAME URI fails at the watch. Rolling that back
         // with a close would release the hold the first open established, which
         // the server keys per (uri, clientId) and cannot tell apart.
         behaviour.failWatch = true;
         await expect(panel.openDocument({ uri: URI_A })).rejects.toThrow(/watch refused/);
         await tick(5);

         expect(closes(calls)).toEqual([]);
      } finally {
         connection.dispose();
         pair.dispose();
      }
   });
});

describe('DataConnectionWithEvents', () => {
   function eventsHarness(): { connection: DataConnectionWithEvents<ProbeElement>; notify: (uri: string) => void; dispose(): void } {
      const pair = makeDuplexConnectionPair();
      recordingServer(pair.left);
      const fakePort = makeFakeDataPort({ connect: () => pair.right });
      const connection = new DataConnectionWithEvents<ProbeElement>(fakePort);
      return {
         connection,
         notify: (uri: string) =>
            void pair.left
               .sendNotification(`${DATA_SERVER_WIRE_PREFIX}onDocumentUpdated`, {
                  document: document(uri),
                  sourceClientId: 'panel',
                  reason: 'changed'
               })
               .catch(() => undefined),
         dispose: () => {
            connection.dispose();
            pair.dispose();
         }
      };
   }

   it('fans one server push out to every listener', async () => {
      const { connection, notify, dispose } = eventsHarness();
      try {
         // A connection binds exactly ONE client, and a method name maps to one
         // handler — a second registration replaces the first silently. So
         // without the fan-out only the first interested party could ever hear
         // the server, and two listeners is the smallest case that tells
         // fan-out from plain delivery.
         const seen: string[] = [];
         connection.events.onDidUpdateDocument(event => seen.push(`first:${event.document.uri}`));
         connection.events.onDidUpdateDocument(event => seen.push(`second:${event.document.uri}`));
         // The generation, and with it the inbound binding, is built lazily on
         // first use — nothing is bound until something asks.
         await connection.connected();

         notify(URI_A);
         await waitFor(() => seen.length >= 2);

         expect(seen).toEqual([`first:${URI_A}`, `second:${URI_A}`]);
      } finally {
         dispose();
      }
   });

   it('disposes the fan-out it created', async () => {
      const { connection, dispose } = eventsHarness();
      try {
         const seen: string[] = [];
         connection.events.onDidUpdateDocument(() => seen.push('heard'));
         await connection.connected();

         connection.dispose();
         // Driven through the WIRE method rather than the server: disposing the
         // connection already kills the transport, so a real push reaches
         // nothing whether or not the emitters were torn down — the absence
         // would hold in both states and witness neither.
         connection.events.onDocumentUpdated({ document: document(URI_A), sourceClientId: 'panel', reason: 'changed' } as never);

         expect(seen).toEqual([]);
      } finally {
         dispose();
      }
   });
});
