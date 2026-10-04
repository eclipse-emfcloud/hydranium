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
import { inject, injectable } from 'inversify';
import { HydraniumGlspOperationCommand, openOperationOf, runOperation } from './hydranium-glsp-operation-command.js';
import { type HydraniumGlspRecordingState } from './hydranium-glsp-recording-command.js';

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

   protected override executeHandler(operation: Operation, handler: OperationHandler): Promise<Action[]> {
      const queued = openOperationOf(this.modelState) !== undefined;
      const run = this.modelState.runExclusive(() => this.runOperation(operation, handler));
      if (!queued) {
         return run;
      }
      run.then(
         actions => this.deliverQueued(actions),
         (error: unknown) => this.reportFailure(operation, error)
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
    * operation's.
    */
   protected deliverQueued(actions: Action[]): void {
      const messages = actions.filter(action => MessageAction.is(action));
      messages.forEach(message => this.sendToClient(message));
      this.actionDispatcher
         .dispatchAll(actions.filter(action => !MessageAction.is(action)))
         .catch((error: unknown) => this.logger.warn(`Could not deliver the result of a queued operation: ${String(error)}`));
   }

   /**
    * Log `error` and send the client the error message GLSP sends for a failed
    * client action.
    */
   protected reportFailure(operation: Operation, error: unknown): void {
      let message = `Could not process action: '${operation.kind}`;
      this.logger.error(message, error);
      let details = error instanceof Error ? error.toString() : String(error);
      if (error instanceof GLSPServerError) {
         details = String(error.cause);
         message = error.message;
      }
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
         this.logger.warn(`Could not send '${action.kind}' to the client: ${String(error)}`);
      }
   }
}
