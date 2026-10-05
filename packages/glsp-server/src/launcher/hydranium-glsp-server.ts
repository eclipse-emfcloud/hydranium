/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type ClientSession,
   DefaultGLSPServer,
   GLSPServerError,
   RejectAction,
   type RequestAction,
   type ResponseAction,
   SourceModelStorage
} from '@eclipse-glsp/server';
import { type InitializeClientSessionParameters } from '@eclipse-glsp/protocol';
import { RequestSaveModelAction } from '@hydranium/protocol';
import { injectable } from 'inversify';
import { HydraniumGlspStorage } from '../storage/hydranium-glsp-storage.js';

/**
 * The GLSP server the framework binds in place of upstream's
 * {@link DefaultGLSPServer}, so a failed REQUEST reaches its reader with the
 * text the thrower wrote, and a diagram whose connection ends keeps its unsaved
 * text for the release grace (see {@link shutdown}).
 *
 * **What breaks without it.** Upstream projects a failing request's detail as
 * `error.cause?.toString()` whenever the error is a {@link GLSPServerError},
 * and that one value feeds both the server log and the client's
 * {@link RejectAction}. A {@link GLSPServerError} carrying no `cause` therefore
 * reaches its readers as `undefined` — the log line and the client's
 * action-dispatcher warning both print it — while a plain `Error` survives,
 * because the other branch reads the error itself. The typed error is the trap,
 * and it is the one upstream's own
 * `getOrThrow` helper raises: that helper's signature cannot pass a `cause`, so
 * an adopter using the sanctioned helper has no fix available on their side.
 * Restating the cause at each throw site is the alternative, and it costs
 * every adopter a rule they must know and cannot apply to `getOrThrow`.
 *
 * Only the REQUEST path needs this. Non-request actions fail through
 * upstream's `handleProcessError`, which reads `message` directly.
 *
 * An adopter who binds their own GLSP server extends this class rather than
 * {@link DefaultGLSPServer}: the framework's server-container override keeps a
 * server that extends this one and replaces any other, so a subclass of
 * upstream's server is discarded, and with it both behaviours.
 */
@injectable()
export class HydraniumGlspServer extends DefaultGLSPServer {
   /**
    * End each diagram's client session as lost rather than closed, before
    * upstream disposes the sessions, so its unsaved text waits out the release
    * grace for the client to reconnect. A shutdown is how the client's
    * connection ending reaches the server; a client that stops on purpose
    * shuts the server down the same way, and its diagrams are held as well.
    */
   override shutdown(): void {
      for (const session of this.clientSessions.values()) {
         const storage = session.container.isBound(SourceModelStorage) ? session.container.get(SourceModelStorage) : undefined;
         if (storage instanceof HydraniumGlspStorage) {
            storage.dispose('lost');
         } else if (storage) {
            this.logger.debug(`Shutdown leaves ending ${session.id} to its storage, which is not a HydraniumGlspStorage`);
         }
      }
      super.shutdown();
   }

   /**
    * End a session the id still has before initializing it again. A model
    * source initializes once, so a second initialize under one id is a new
    * widget, a reopened tab whose closed predecessor's dispose never arrived;
    * upstream would hand it that stale session.
    */
   override async initializeClientSession(params: InitializeClientSessionParameters): Promise<void> {
      if (!this.clientSessions.has(params.clientSessionId)) {
         return super.initializeClientSession(params);
      }
      this.logger.warn(`Client session ${params.clientSessionId} initialized again before its dispose arrived; ending the old one`);
      // Not awaited before the initialize: both drop and set the session before
      // their first await, and the model request that follows is read without
      // waiting for this one to settle.
      const disposed = this.disposeClientSession({ clientSessionId: params.clientSessionId });
      const initialized = super.initializeClientSession(params);
      await Promise.all([disposed, initialized]);
   }

   /**
    * The detail projected into the client's {@link RejectAction} and the server
    * log when a request fails.
    *
    * A {@link GLSPServerError} with no `cause` falls back to its `message`; a
    * nullish `cause` counts as absent, matching the optional chaining upstream
    * applies. Anything else stringifies as upstream does, so a plain `Error`
    * keeps its `"Error: …"` prefix and callers that match on it still match.
    */
   protected requestFailureDetail(error: unknown): string | undefined {
      if (error instanceof GLSPServerError) {
         return error.cause === undefined || error.cause === null ? error.message : String(error.cause);
      }
      return error === undefined || error === null ? undefined : String(error);
   }

   /**
    * Lifted verbatim from `@eclipse-glsp/server` 2.7.0's
    * {@link DefaultGLSPServer.handleClientRequest}, with the detail computation
    * delegated to {@link requestFailureDetail}, and one addition: a failed
    * {@link RequestSaveModelAction} also raises the error notification a failed
    * `SaveModelAction` raises. A rejection reaches only the client's log, and a
    * Theia host only logs a rejected save, so without it a save that failed
    * would tell the user nothing. Nothing else here — the timeout branch, the
    * response dispatch, the nested send-failure handling — relates to either.
    *
    * **This body does not track upstream.** A release that changes request
    * handling would silently not apply, on the path every request takes. There
    * is no narrower seam to override: upstream computes the detail inline. The
    * accompanying test pins upstream's own source for this method, so a bump
    * that changes it fails rather than diverging quietly; re-lift the body when
    * it does.
    */
   protected override async handleClientRequest(
      clientSession: ClientSession,
      action: RequestAction<ResponseAction>,
      clientId: string
   ): Promise<void> {
      try {
         const response =
            action.timeout !== undefined
               ? await clientSession.actionDispatcher.requestUntil(action, action.timeout, true)
               : await clientSession.actionDispatcher.request(action);
         if (response) {
            this.sendResponseToClient(clientId, response);
         }
      } catch (error: unknown) {
         const detail = this.requestFailureDetail(error);
         this.logger.error(`Failed to handle request '${action.kind}' (${action.requestId}):`, detail);
         try {
            const reject = RejectAction.create(`Failed to handle request '${action.kind}' (${action.requestId})`, {
               responseId: action.requestId,
               detail
            });
            this.sendResponseToClient(clientId, reject);
            // Inside the guard: `process` does not await this method, so a
            // closed connection throwing here would be an unhandled rejection.
            if (action.kind === RequestSaveModelAction.KIND) {
               this.handleProcessError({ clientId, action }, error);
            }
         } catch (sendError: unknown) {
            this.logger.error(`Failed to send rejection for request '${action.requestId}':`, sendError);
         }
      }
   }
}
