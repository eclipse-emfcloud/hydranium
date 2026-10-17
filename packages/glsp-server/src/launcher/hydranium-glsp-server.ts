/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type ActionMessage,
   ClientAction,
   type ClientSession,
   DefaultGLSPServer,
   GLSPServerError,
   type InitializeClientSessionParameters,
   MessageAction,
   RejectAction,
   RequestAction,
   type ResponseAction,
   SourceModelStorage
} from '@eclipse-glsp/server';
import { describeErrorWithStack, RequestSaveModelAction } from '@hydranium/protocol';
import { injectable } from 'inversify';
import { logActionFailure } from '../command/diagram-edit-dropped-error.js';
import { HydraniumGlspStorage } from '../storage/hydranium-glsp-storage.js';
import { takeSettleFailureLogged } from '../storage/logged-settle-failures.js';

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
 * Only the REQUEST path needs this. A non-request action fails through
 * {@link handleProcessError}, which reads `message` directly; it and
 * {@link process} are lifted for their logging only.
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
      this.logger.debug(`Client session ${params.clientSessionId} initialized again before its dispose arrived; ending the old one`);
      // Not awaited before the initialize: both drop and set the session before
      // their first await, and the model request that follows is read without
      // waiting for this one to settle.
      const disposed = this.disposeClientSession({ clientSessionId: params.clientSessionId });
      const initialized = super.initializeClientSession(params);
      await Promise.all([disposed, initialized]);
   }

   /**
    * Lifted from `@eclipse-glsp/server` 2.7.0's {@link DefaultGLSPServer.process}:
    * each action is logged at `debug` rather than `info`, and an action that
    * fails once its session has ended, which disposing the session's dispatcher
    * does to every action it holds, is logged at `debug` and told to no client,
    * since the one that sent it has gone. The accompanying test pins upstream's
    * source.
    */
   override process(message: ActionMessage): void {
      this.validateServerInitialized();
      this.logger.debug(`process [action=${message.action.kind}, clientId=${message.clientId}]`);
      const clientSessionId = message.clientId;
      const clientSession = this.clientSessions.get(clientSessionId);
      if (!clientSession) {
         throw new Error(`No client session has been initialized for client id: ${clientSessionId}`);
      }
      const action = message.action;
      ClientAction.mark(action);
      if (RequestAction.is(action)) {
         void this.handleClientRequest(clientSession, action, message.clientId);
         return;
      }
      clientSession.actionDispatcher.dispatch(action).catch((error: unknown) => {
         if (this.clientSessions.get(clientSessionId) === clientSession) {
            void this.handleProcessError(message, error);
         } else {
            this.logger.debug(`Action '${action.kind}' ended with its session: ${describeErrorWithStack(error)}`);
         }
      });
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
    * Lifted from `@eclipse-glsp/server` 2.7.0's
    * {@link DefaultGLSPServer.handleProcessError}, logging the failure once
    * with {@link logActionFailure} where upstream logs the action and the
    * reason as two lines.
    *
    * The notification is upstream's, text and all, and this body does not
    * track upstream: the accompanying test pins upstream's source as it does
    * for {@link handleClientRequest}.
    */
   protected override handleProcessError(message: ActionMessage, reason: unknown): void {
      const kind = message.action.kind;
      logActionFailure(this.logger, message.action, reason);
      let errorMsg = `Could not process action: '${kind}`;
      let details = stringifyAsUpstream(reason);
      if (reason instanceof GLSPServerError) {
         details = stringifyAsUpstream(reason.cause);
         errorMsg = reason.message;
      }
      this.sendToClient({ clientId: message.clientId, action: MessageAction.create(errorMsg, { severity: 'ERROR', details }) });
   }

   /**
    * Lifted from `@eclipse-glsp/server` 2.7.0's
    * {@link DefaultGLSPServer.handleClientRequest}, with the detail computation
    * delegated to {@link requestFailureDetail}. A failure is logged once, with
    * its stack; a settle request's failure its handler has logged already is
    * not logged again. A request that fails once its session has ended is
    * logged at `debug` and answered to no client, as {@link process} treats an
    * action. One addition: a failed {@link RequestSaveModelAction} also raises
    * the error notification a failed `SaveModelAction` raises, through
    * {@link handleProcessError}, which then logs it instead. A rejection
    * reaches only the client's log, and a Theia host only logs a rejected save,
    * so without it a save that failed would tell the user nothing. Nothing else
    * here — the timeout branch, the response dispatch, the nested send-failure
    * handling — relates to either.
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
         if (this.clientSessions.get(clientSession.id) !== clientSession) {
            this.logger.debug(`Request '${action.kind}' (${action.requestId}) ended with its session: ${describeErrorWithStack(error)}`);
            return;
         }
         const detail = this.requestFailureDetail(error);
         const isSave = action.kind === RequestSaveModelAction.KIND;
         // A settle failure the handler logged, with the stack its rejection does not carry.
         if (!isSave && !takeSettleFailureLogged(clientId, action.requestId)) {
            this.logger.error(`Failed to handle request '${action.kind}' (${action.requestId}): ${describeErrorWithStack(error)}`);
         }
         // Inside the guard: `process` does not await this method, so a throw
         // here would be an unhandled rejection.
         try {
            try {
               const reject = RejectAction.create(`Failed to handle request '${action.kind}' (${action.requestId})`, {
                  responseId: action.requestId,
                  detail
               });
               this.sendResponseToClient(clientId, reject);
            } finally {
               // Also when the reject could not be sent, since this logs the save's failure.
               if (isSave) {
                  this.handleProcessError({ clientId, action }, error);
               }
            }
         } catch (sendError: unknown) {
            this.logger.error(`Failed to send rejection for request '${action.requestId}': ${describeErrorWithStack(sendError)}`);
         }
      }
   }
}

/** `value?.toString?.()`, as upstream projects a reason into a notification's details. */
function stringifyAsUpstream(value: unknown): string | undefined {
   return (value as { toString?: () => string } | null | undefined)?.toString?.();
}
