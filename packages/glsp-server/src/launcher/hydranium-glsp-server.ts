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
   type ResponseAction
} from '@eclipse-glsp/server';
import { injectable } from 'inversify';

/**
 * The GLSP server the framework binds in place of upstream's
 * {@link DefaultGLSPServer}, so a failed REQUEST reaches its reader with the
 * text the thrower wrote.
 *
 * **What breaks without it.** Upstream projects a failing request's detail as
 * `error.cause?.toString()` whenever the error is a {@link GLSPServerError},
 * and that one value feeds both the server log and the client's
 * {@link RejectAction}. A {@link GLSPServerError} carrying no `cause` therefore
 * reaches no reader at all — not the toast, not the details pane, not the log —
 * while a plain `Error` survives, because the other branch reads the error
 * itself. The typed error is the trap, and it is the one upstream's own
 * `getOrThrow` helper raises: that helper's signature cannot pass a `cause`, so
 * an adopter using the sanctioned helper has no fix available on their side.
 * Restating the cause at each throw site is the alternative, and it costs
 * every adopter a rule they must know and cannot apply to `getOrThrow`.
 *
 * Only the REQUEST path needs this. Non-request actions fail through
 * upstream's `handleProcessError`, which reads `message` directly.
 *
 * Adopters who bind their own GLSP server should extend this class rather than
 * {@link DefaultGLSPServer}; the framework's server-container override replaces
 * whatever the adopter's `ServerModule` bound, so a subclass of upstream's
 * server would be discarded.
 */
@injectable()
export class HydraniumGlspServer extends DefaultGLSPServer {
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
    * delegated to {@link requestFailureDetail}. Nothing else here — the
    * timeout branch, the response dispatch, the nested send-failure handling —
    * relates to that fallback.
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
         } catch (sendError: unknown) {
            this.logger.error(`Failed to send rejection for request '${action.requestId}':`, sendError);
         }
      }
   }
}
