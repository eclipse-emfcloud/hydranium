/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataConnection, DataServerProtocol, DataSession, DiagnosticOf, TransferElement } from '@hydranium/protocol';
// Type-only: the `@theia/core/lib/browser` barrel touches DOM globals at module
// load, which the node-environment unit tests cannot provide.
import type { FrontendApplicationContribution, OnWillStopAction } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';

/**
 * Ends a Theia frontend's data sessions with its page, and holds the page
 * while one of them is still saving. Bind it as a
 * `FrontendApplicationContribution` in singleton scope and {@link track} each
 * data connection the frontend binds, once.
 *
 * **Stop.** {@link onStop} disposes every tracked session, which sends its
 * `closeSession`, so the server ends it as closed: each document it was the
 * last to hold reverts at once. Otherwise the server learns of the page only
 * when its connection goes, which Theia may hold open for its reconnect
 * timeout, and then ends the sessions as lost, so their documents wait out the
 * revert grace. The close is best effort: under load the page's last frames
 * can be lost on the way, and the server then ends the sessions as lost. A
 * session with calls still in flight at the stop closes after them, which is
 * too late for a page going away, and is left to the server's connection-close
 * cleanup. A call a session makes in the same tick as the stop is refused and
 * never sent.
 *
 * **Veto.** While a tracked session has a save in flight, {@link onWillStop}
 * vetoes, including a session disposed meanwhile. In Electron, Theia awaits
 * the veto's action, which waits for the saves to answer, a save started during
 * the wait included, up to {@link maxSettlePasses} times. The browser runs no
 * action before unload, so there the veto shows the leave-page prompt and
 * nothing more. Theia ignores every veto under
 * `application.confirmExit: 'never'`, so there a save in flight at the stop
 * may be cut off.
 */
@injectable()
export class DataSessionStopContribution implements FrontendApplicationContribution {
   /** The sessions to end at the stop, and to wait for while they save. */
   protected readonly sessions = new Set<DataSession<TransferElement>>();
   /**
    * How many times the veto's action waits for the saves in flight before it
    * lets the stop go. Each wait ends by the session's own bound, so a save
    * that never answers holds the stop for a few bounds, not for good.
    */
   protected readonly maxSettlePasses: number = 3;

   /**
    * Take every session of `connection` into the stop: the ones it has
    * started already, and each one it starts from now on. Generic, so a
    * connection of any transfer root, server and client fits.
    */
   track<TTransfer extends TransferElement, TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>>, TClient extends object>(
      connection: DataConnection<TTransfer, TServer, TClient>
   ): void {
      connection.liveSessions.forEach(session => this.trackSession(session));
      connection.onDidCreateSession(session => this.trackSession(session));
   }

   /**
    * Take `session` into the stop. It leaves once it has ended and its saves
    * have answered, so a session disposed with a save in flight still holds
    * the page.
    */
   protected trackSession(session: DataSession<TransferElement>): void {
      this.sessions.add(session);
      // A save can outlast the wait's bound, so the session stays until none
      // is left in flight.
      const release = (): void =>
         void session.whenSavesSettled().then(() => (session.hasSavesInFlight ? release() : this.sessions.delete(session)));
      // An ended session has fired its event already, and never fires it again.
      if (session.isDisposed) {
         release();
      } else {
         session.onDidDispose(release);
      }
   }

   onWillStop(): OnWillStopAction | undefined {
      if (this.savingSessions().length === 0) {
         return undefined;
      }
      return {
         // Theia logs the reason and shows it nowhere, so it is not translated.
         reason: 'Data sessions are saving',
         action: async () => {
            // The page stays usable while Theia awaits this, so a save can
            // start during a wait; each pass waits for the saves then in flight.
            for (let pass = 0; pass < this.maxSettlePasses; pass++) {
               const saving = this.savingSessions();
               if (saving.length === 0) {
                  break;
               }
               await Promise.all(saving.map(session => session.whenSavesSettled()));
            }
            return true;
         }
      };
   }

   /** The tracked sessions with a save in flight. */
   protected savingSessions(): DataSession<TransferElement>[] {
      return [...this.sessions].filter(session => session.hasSavesInFlight);
   }

   onStop(): void {
      for (const session of this.sessions) {
         session.dispose();
      }
   }
}
