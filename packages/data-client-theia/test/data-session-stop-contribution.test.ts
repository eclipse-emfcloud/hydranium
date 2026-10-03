/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import {
   DataConnection,
   DataEvents,
   DataSession,
   Deferred,
   type DataServerProtocol,
   type RpcProxy,
   type TransferElement
} from '@hydranium/protocol';
import { makeFakeDataPort, tick } from '@hydranium/protocol/lib/testing';
import type { OnWillStopAction } from '@theia/core/lib/browser';
import { DataSessionStopContribution } from '../src/browser/data-session-stop-contribution';

type Server = RpcProxy<DataServerProtocol<TransferElement>>;

/**
 * A real connection whose sessions talk to a server stand-in that answers
 * in-process. `closedBeforeTimer` records, per session end the server saw,
 * whether a timer queued just before the stop had fired by then: a page's stop
 * is its last task, so a close that needs a later one never leaves the page.
 */
function makeConnection(saveGate?: Promise<void>): {
   connection: DataConnection<TransferElement>;
   server: Server;
   closed: string[];
   closedBeforeTimer: boolean[];
   armTimer(): void;
} {
   const closed: string[] = [];
   const closedBeforeTimer: boolean[] = [];
   let timerFired = false;
   const document = (uri: string): unknown => ({ uri, version: 1, root: { $type: 'TypeOne' }, diagnostics: [] });
   const server = {
      createSession: async (): Promise<void> => undefined,
      closeSession: async (args: { clientId: string }): Promise<void> => {
         closed.push(args.clientId);
         closedBeforeTimer.push(!timerFired);
      },
      openModelDocument: async (args: { uri: string }): Promise<unknown> => document(args.uri),
      watchModelDocument: async (): Promise<void> => undefined,
      saveModelDocument: async (args: { uri: string }): Promise<unknown> => {
         await saveGate;
         return document(args.uri);
      }
   } as unknown as Server;
   const port = makeFakeDataPort({
      connect: () => {
         throw new Error('the sessions here talk to the stand-in, never to the port');
      }
   });
   const connection = new DataConnection<TransferElement>(port, new DataEvents<TransferElement>(), {
      sessionFactory: (clientId, _host, label) => new DataSession<TransferElement>(clientId, { connected: async () => server }, label)
   });
   return {
      connection,
      server,
      closed,
      closedBeforeTimer,
      armTimer: () => {
         timerFired = false;
         setTimeout(() => (timerFired = true), 0);
      }
   };
}

/** Exposes the per-session seam, and how many sessions the stop still holds, which no public member shows. */
class InspectableStop extends DataSessionStopContribution {
   get trackedCount(): number {
      return this.sessions.size;
   }

   trackOne(session: DataSession<TransferElement>): void {
      this.trackSession(session);
   }
}

/** A session whose wait for its calls gives up almost at once. */
class ShortBoundSession extends DataSession<TransferElement> {
   protected override readonly settleBeforeCloseMs = 5;
}

const URI = 'file:///a.x';
const MODEL = { $type: 'TypeOne' } as const;

describe('DataSessionStopContribution', () => {
   it('ends every session of a tracked connection on the server within the stopping task', async () => {
      const { connection, closed, closedBeforeTimer, armTimer } = makeConnection();
      const contribution = new DataSessionStopContribution();
      contribution.track(connection);
      const panel = connection.createSession('panel', 'panel');
      const tree = connection.createSession('tree', 'tree');
      await Promise.all([panel.connected(), tree.connected()]);

      armTimer();
      contribution.onStop();
      await tick(5);

      expect(closed).toEqual(['panel', 'tree']);
      expect(closedBeforeTimer).toEqual([true, true]);
   });

   it('takes in the sessions a connection started before it was tracked', async () => {
      const { connection, closed } = makeConnection();
      const panel = connection.createSession('panel', 'panel');
      const contribution = new DataSessionStopContribution();
      contribution.track(connection);
      await panel.connected();

      contribution.onStop();
      await tick(5);

      expect(closed).toEqual(['panel']);
   });

   it('does not end a session again that ended before the stop', async () => {
      const { connection, closed } = makeConnection();
      const contribution = new DataSessionStopContribution();
      contribution.track(connection);
      const panel = connection.createSession('panel', 'panel');
      await panel.connected();
      panel.dispose();
      await tick(5);

      contribution.onStop();
      await tick(5);

      expect(closed).toEqual(['panel']);
   });

   it('lets go of a session that had ended before it was tracked', async () => {
      // An ended session never fires its event again, so waiting for it would
      // hold the session for good.
      const { connection } = makeConnection();
      const contribution = new InspectableStop();
      const panel = connection.createSession('panel', 'panel');
      panel.dispose();

      contribution.trackOne(panel);
      await tick(5);

      expect(contribution.trackedCount).toBe(0);
   });

   it('raises no veto while no tracked session is saving', async () => {
      const { connection } = makeConnection();
      const contribution = new DataSessionStopContribution();
      contribution.track(connection);
      const panel = connection.createSession('panel', 'panel');
      await panel.openDocument({ uri: URI });

      expect(contribution.onWillStop()).toBeUndefined();
   });

   it('vetoes the stop while a save is in flight, and lets it go once the save answers', async () => {
      const save = new Deferred<void>();
      const { connection } = makeConnection(save.promise);
      const contribution = new DataSessionStopContribution();
      contribution.track(connection);
      const panel = connection.createSession('panel', 'panel');
      await panel.openDocument({ uri: URI });
      const saving = panel.saveDocument({ uri: URI, model: MODEL, baseVersion: 'any' });

      const veto = contribution.onWillStop() as OnWillStopAction;
      expect(veto).toBeDefined();
      let allowed: boolean | undefined;
      const deciding = Promise.resolve(veto.action(undefined)).then(result => (allowed = result));
      await tick(5);
      expect(allowed).toBeUndefined();

      save.resolve();
      await Promise.all([saving, deciding]);
      expect(allowed).toBe(true);
   });

   it('waits for a save that starts while the veto waits', async () => {
      // In Electron the page stays usable while Theia awaits the action, so an
      // auto-save or a keystroke can start a save after the veto was raised.
      const first = new Deferred<void>();
      const second = new Deferred<void>();
      const { server } = makeConnection(first.promise);
      const { server: laterServer } = makeConnection(second.promise);
      const contribution = new InspectableStop();
      const panel = new DataSession<TransferElement>('panel', { connected: async () => server }, 'panel');
      const tree = new DataSession<TransferElement>('tree', { connected: async () => laterServer }, 'tree');
      contribution.trackOne(panel);
      contribution.trackOne(tree);
      await Promise.all([panel.openDocument({ uri: URI }), tree.openDocument({ uri: URI })]);
      const saving = panel.saveDocument({ uri: URI, model: MODEL, baseVersion: 'any' });

      const veto = contribution.onWillStop() as OnWillStopAction;
      let allowed: boolean | undefined;
      const deciding = Promise.resolve(veto.action(undefined)).then(result => (allowed = result));
      await tick(5);
      const later = tree.saveDocument({ uri: URI, model: MODEL, baseVersion: 'any' });
      first.resolve();
      await saving;
      await tick(5);
      expect(allowed).toBeUndefined();

      second.resolve();
      await Promise.all([later, deciding]);
      expect(allowed).toBe(true);
   });

   it('lets the stop go after its passes when a save never answers', async () => {
      const { server } = makeConnection(new Deferred<void>().promise);
      const contribution = new InspectableStop();
      const panel = new ShortBoundSession('panel', { connected: async () => server }, 'panel');
      contribution.trackOne(panel);
      await panel.openDocument({ uri: URI });
      void panel.saveDocument({ uri: URI, model: MODEL, baseVersion: 'any' });
      await tick(5);

      const veto = contribution.onWillStop() as OnWillStopAction;

      await expect(Promise.resolve(veto.action(undefined))).resolves.toBe(true);
      expect(panel.hasSavesInFlight).toBe(true);
   });

   it('still vetoes for a session disposed while its save is in flight, and forgets it once the save answers', async () => {
      // Its save was sent, but in Electron the window's close takes the backend
      // with it, and the server with the backend, before the save lands.
      const save = new Deferred<void>();
      const { connection } = makeConnection(save.promise);
      const contribution = new InspectableStop();
      contribution.track(connection);
      const panel = connection.createSession('panel', 'panel');
      await panel.openDocument({ uri: URI });
      const saving = panel.saveDocument({ uri: URI, model: MODEL, baseVersion: 'any' });
      // On the wire before the dispose, which refuses a call it overtakes.
      await tick(5);

      panel.dispose();

      expect(contribution.onWillStop()).toBeDefined();
      save.resolve();
      await saving;
      await tick(5);
      expect(contribution.onWillStop()).toBeUndefined();
      expect(contribution.trackedCount).toBe(0);
   });

   it('keeps a disposed session whose save outlasts the wait, and still vetoes for it', async () => {
      const save = new Deferred<void>();
      const { server } = makeConnection(save.promise);
      const contribution = new InspectableStop();
      const panel = new ShortBoundSession('panel', { connected: async () => server }, 'panel');
      contribution.trackOne(panel);
      await panel.openDocument({ uri: URI });
      const saving = panel.saveDocument({ uri: URI, model: MODEL, baseVersion: 'any' });
      await tick(5);

      panel.dispose();
      await tick(20);

      expect(contribution.trackedCount).toBe(1);
      expect(contribution.onWillStop()).toBeDefined();
      save.resolve();
      await saving;
      await tick(20);
      expect(contribution.trackedCount).toBe(0);
   });
});
