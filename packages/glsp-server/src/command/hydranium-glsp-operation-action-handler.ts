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
   type AnyObject,
   GLSPClientProxy,
   GLSPServerError,
   Logger,
   MessageAction,
   type Operation,
   OperationActionHandler,
   type OperationHandler
} from '@eclipse-glsp/server';
import { type ServerSharedServices } from '@hydranium/core';
import { describeErrorWithStack, isResponseError } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { logActionFailure } from './diagram-edit-dropped-error.js';
import { HydraniumGlspOperationCommand, openOperationOf, runOperation } from './hydranium-glsp-operation-command.js';
import { type HydraniumGlspRecordingState } from './hydranium-glsp-recording-command.js';
import { trackQueuedDelivery } from './queued-deliveries.js';

/**
 * GLSP's operation action handler, running each operation as a
 * {@link HydraniumGlspOperationCommand} inside the state's `runExclusive`,
 * which covers the operation, its write, the command-stack push and the
 * submit, so neither another operation, an undo nor the storage's capture
 * lands between them.
 *
 * An operation dispatched while another is open, as a handler's plain
 * `dispatch` does, is queued behind it and its dispatch resolves at once;
 * awaited inside the open operation, it would wait for the operation awaiting
 * it. It writes, pushes and submits on its own, and a failure is reported to
 * the client as GLSP reports a failed client action.
 *
 * Only operations are queued that way, and only while one is open, its undo's
 * side effects included. Code running inside the boundary otherwise must not
 * dispatch an operation and await it: a GModel factory or a submit after an
 * operation, an undo's write and submit, the storage's render. Nor may any code
 * inside the boundary await a dispatched undo, redo or model request, which
 * take the boundary themselves. Each waits for the section awaiting it.
 */
@injectable()
export class HydraniumGlspOperationActionHandler extends OperationActionHandler {
   declare protected modelState: HydraniumGlspRecordingState<AnyObject>;
   @inject(ActionDispatcher) protected readonly actionDispatcher!: ActionDispatcher;
   @inject(Logger) protected readonly logger!: Logger;
   @inject(GLSPClientProxy) protected readonly clientProxy!: GLSPClientProxy;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   /**
    * Runs `operation`, or queues it behind the open one and tracks its delivery,
    * which a settle request waits for. An override must call this one, or a
    * settle answers before what the queued operation sends.
    */
   protected override executeHandler(operation: Operation, handler: OperationHandler): Promise<Action[]> {
      const queued = openOperationOf(this.modelState) !== undefined;
      const run = this.modelState.runExclusive(() => this.runOperation(operation, handler));
      if (!queued) {
         return run;
      }
      trackQueuedDelivery(
         this.modelState,
         run.then(
            actions => this.deliverQueued(actions),
            (error: unknown) => this.reportFailure(operation, error)
         )
      );
      return Promise.resolve([]);
   }

   /**
    * Run `operation`; push it when its command was written, and submit the
    * model when it executed one, written or dropped.
    */
   protected async runOperation(operation: Operation, handler: OperationHandler): Promise<Action[]> {
      // A queued operation can find the diagram read-only by the time it runs.
      if (this.modelState.isReadonly) {
         return [
            MessageAction.create(`Server is in readonly-mode! Could not execute operation: ${operation.kind}`, { severity: 'WARNING' })
         ];
      }
      const command = new HydraniumGlspOperationCommand(this.modelState);
      const outcome = await runOperation(command, () => handler.execute(operation));
      if (outcome === 'none') {
         return [];
      }
      if (outcome === 'executed') {
         await this.executeCommand(command);
      }
      return this.submitModel();
   }

   /**
    * Deliver what a queued operation answered: a message straight to the
    * client, as {@link reportFailure} sends one, the rest through the
    * dispatcher. A failure to deliver is logged, not reported as the
    * operation's. Resolves once delivered, and never rejects.
    */
   protected deliverQueued(actions: Action[]): Promise<void> {
      const messages = actions.filter(action => MessageAction.is(action));
      messages.forEach(message => this.sendToClient(message));
      return this.actionDispatcher
         .dispatchAll(actions.filter(action => !MessageAction.is(action)))
         .catch((error: unknown) =>
            this.logger.warn(`Could not deliver the result of a queued operation: ${describeErrorWithStack(error)}`)
         );
   }

   /**
    * Log `error` with {@link logActionFailure}, as the server logs a failed
    * action, and send the client the error message GLSP sends for one, headed
    * by a typed error's rendered message as the server's notification is. A
    * queued operation that fails once its diagram has closed, which the
    * storage's dispose marks by clearing the state's session, is logged at
    * `debug` and told to no client, as the server treats an ended session.
    */
   protected reportFailure(operation: Operation, error: unknown): void {
      // Queued only after a load registered the session, so none now means the diagram has closed.
      if (this.modelState.modelSession === undefined) {
         this.logger.debug(`Operation '${operation.kind}' ended with its diagram: ${describeErrorWithStack(error)}`);
         return;
      }
      logActionFailure(this.logger, operation, error);
      let message = `Could not process action: '${operation.kind}`;
      let details = error instanceof Error ? error.toString() : String(error);
      if (error instanceof GLSPServerError) {
         details = String(error.cause);
         message = error.message;
      } else if (isResponseError(error)) {
         message = this.sharedServices.MessageRenderer.renderError(error);
      }
      // An error even for a write the log calls declined, a conflict or a syntax refusal, since the gesture is lost.
      // A refused undo is a warning instead: it keeps its history and works once the text parses.
      this.sendToClient(MessageAction.create(message, { severity: 'ERROR', details }));
   }

   /**
    * Send `action` straight to the client, as GLSP's server sends a failed
    * action's message. Sent through the dispatcher instead, an action of a
    * kind the client registered no handler for is rejected.
    */
   protected sendToClient(action: Action): void {
      try {
         this.clientProxy.process({ clientId: this.modelState.clientId, action });
      } catch (error: unknown) {
         this.logger.warn(`Could not send '${action.kind}' to the client: ${describeErrorWithStack(error)}`);
      }
   }
}
