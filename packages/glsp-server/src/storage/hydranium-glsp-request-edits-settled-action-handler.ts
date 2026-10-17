/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   ActionDispatcher,
   type ActionHandler,
   ClientSessionManager,
   Logger,
   ModelState,
   RejectAction,
   SourceModelStorage
} from '@eclipse-glsp/server';
import type { ServerSharedServices } from '@hydranium/core';
import type { AstNode } from '@hydranium/langium';
import { EditsSettledAction, RequestEditsSettledAction, TIMED_OUT, describeError, describeErrorWithStack } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { queuedDeliveriesOf } from '../command/queued-deliveries.js';
import { HydraniumGlspServerActionDispatcher } from '../dispatcher/server-action-dispatcher.js';
import { markSettleFailureLogged, takeSettleFailureLogged } from './logged-settle-failures.js';
import type { AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { HydraniumGlspStorage } from './hydranium-glsp-storage.js';

/**
 * Answers a {@link RequestEditsSettledAction} with an {@link EditsSettledAction}
 * once the language client has answered the push of each document a save
 * writes, as {@link HydraniumGlspStorage.openWriteSet} names them: one that
 * left the diagram's set stays open, and in the save, until the next save. A
 * storage of another kind gives the diagram's own documents this client has
 * open.
 *
 * The server handles a client's actions one at a time, so the edits sent before
 * the request have been handled when it runs, except an operation queued behind
 * an open one, which runs in the state's exclusive section after its handler
 * has returned; the handler waits that section out first, then, for at most
 * {@link settleDeliveriesMs}, for what such an operation answered, its dirty
 * state among it, to be delivered; one it gave up on is not waited for again.
 * Their text, though, reaches the language client on a push of its own that the
 * edit does not await; answering before it would let a page that tracks unsaved
 * text through that client read an edit as neither in flight nor unsaved. The
 * wait is bounded, since `settleLanguageClient` resolves rather than rejects
 * past its bound, and the diagram's later actions do not wait for it: the
 * handler returns at once and dispatches its answer, or a rejection, later.
 *
 * `AbstractHydraniumGlspDiagramModule` registers it. A diagram module that does
 * not extend that base adds it in `configureActionHandlers`. Without it the
 * client counts no edit as in flight, as a server that answers nothing would
 * leave the count unended. Over a state that is not an
 * `AbstractHydraniumGlspState` the request fails, and the rejection the server
 * answers with ends the count as an answer would. A request that carries a
 * timeout is rejected by the server once it passes, as any request is, and the
 * answer that follows is dropped.
 */
@injectable()
export class HydraniumGlspRequestEditsSettledActionHandler implements ActionHandler {
   readonly actionKinds = [RequestEditsSettledAction.KIND];

   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;
   @inject(ModelState) protected readonly state!: AbstractHydraniumGlspState<AstNode, unknown>;
   @inject(SourceModelStorage) protected readonly storage!: SourceModelStorage;
   @inject(Logger) protected readonly logger!: Logger;
   @inject(ActionDispatcher) protected readonly actionDispatcher!: ActionDispatcher;
   @inject(ClientSessionManager) protected readonly sessionManager!: ClientSessionManager;

   /** How long {@link answerOnceSettled} waits for the answers of queued operations to be delivered before going on anyway. */
   protected readonly settleDeliveriesMs: number = 5_000;

   execute(request: RequestEditsSettledAction): Action[] {
      const exclusive = this.state.runExclusive(() => undefined);
      void this.answerOnceSettled(request, exclusive);
      return [];
   }

   /**
    * Answer `request` once the waits are over, by dispatch rather than by
    * return: under the browser dispatch scope a queued operation's delivery
    * queues behind the request, so a handler that waited for it would wait out
    * its whole bound.
    */
   protected async answerOnceSettled(request: RequestEditsSettledAction, exclusive: Promise<unknown>): Promise<void> {
      let answer: Action;
      let failure: { error: unknown } | undefined;
      try {
         await exclusive;
         // What is pending now, a delivery an earlier request is waiting for included.
         const deliveries = [...queuedDeliveriesOf(this.state)];
         if ((await this.sharedServices.Clock.raceTimer(Promise.allSettled(deliveries), this.settleDeliveriesMs)) === TIMED_OUT) {
            // Not waited for again by a later request.
            deliveries.forEach(delivery => queuedDeliveriesOf(this.state).delete(delivery));
            this.logger.warn(
               `Answering a settle request after ${this.settleDeliveriesMs} ms, before a queued operation's answers were delivered`
            );
         }
         await Promise.all(this.documentsToSettle().map(uri => this.sharedServices.model.ModelService.settleLanguageClient(uri)));
         answer = EditsSettledAction.create({ responseId: request.requestId });
      } catch (error: unknown) {
         failure = { error };
         // A throw would reach nobody now; the server wraps this in its own rejection.
         answer = RejectAction.create(describeError(error), { responseId: request.requestId });
      }
      if (this.sessionEnded()) {
         this.logger.debug(
            failure === undefined
               ? `Not answering settle request '${request.requestId}': its session has ended`
               : `Settle request '${request.requestId}' failed once its session had ended: ${describeErrorWithStack(failure.error)}`
         );
         return;
      }
      if (failure !== undefined) {
         // Only the rejection's text reaches the server's own failure log, so the stack is logged here.
         this.logger.error(`Settle request '${request.requestId}' failed: ${describeErrorWithStack(failure.error)}`);
         // The server's line would repeat this one; past a timeout it has logged its own and takes no mark.
         if (this.serverAwaitsAnswer(request)) {
            markSettleFailureLogged(this.state.clientId, request.requestId);
         }
      }
      try {
         await this.actionDispatcher.dispatch(answer);
      } catch (error: unknown) {
         takeSettleFailureLogged(this.state.clientId, request.requestId);
         this.logger.warn(`Could not answer settle request '${request.requestId}': ${describeErrorWithStack(error)}`);
      }
   }

   /**
    * Whether the server still awaits the answer to `request`, so its failure
    * line would follow this handler's. Read just before the answer is sent: a
    * timeout cannot pass in between. Over a dispatcher of another kind, whether
    * the request carries no timeout.
    */
   protected serverAwaitsAnswer(request: RequestEditsSettledAction): boolean {
      return this.actionDispatcher instanceof HydraniumGlspServerActionDispatcher
         ? this.actionDispatcher.awaitsResponse(request.requestId)
         : request.timeout === undefined;
   }

   /**
    * Whether the client session this handler serves has ended, by its dispatcher
    * rather than its id, as a client reopening the diagram gets a new session.
    */
   protected sessionEnded(): boolean {
      return this.sessionManager.getSession(this.state.clientId)?.actionDispatcher !== this.actionDispatcher;
   }

   /** The documents a save writes; none before a model is loaded. */
   protected documentsToSettle(): string[] {
      // Typed `string`, but unset until a model loads.
      const sourceUri: string | undefined = this.state.sourceUri;
      if (sourceUri === undefined) {
         return [];
      }
      if (this.storage instanceof HydraniumGlspStorage) {
         return this.storage.openWriteSet(sourceUri);
      }
      const textDocuments = this.sharedServices.workspace.TextDocuments;
      return [sourceUri, ...this.state.secondaryUris].filter(uri => textDocuments.isOpenInClient(uri, this.state.clientId));
   }
}
