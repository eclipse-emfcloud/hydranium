/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   ActionDispatcher,
   type ClientSession,
   type ClientSessionInitializer,
   type ClientSessionListener,
   ClientSessionManager,
   EditMode,
   MessageAction,
   ModelState,
   SetEditModeAction,
   StatusAction
} from '@eclipse-glsp/server';
import { type ServerSharedServices } from '@hydranium/core';
import { type AstNode } from '@hydranium/langium';
import { DisposableCollection, defineMessage, describeErrorWithStack } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { type DiagramStatusEntry } from '../state/diagram-status.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';

/**
 * A diagram edit was dropped because another editor changed the same field
 * first. The diagram returns to the document's state, which without this reads
 * as the edit never having been made. It names the recovery: the edit made
 * again applies to the other editor's change.
 */
export const DIAGRAM_EDIT_DROPPED = defineMessage(
   'hydranium/glsp-server/diagram-edit-dropped',
   'Your diagram change was not applied: another editor changed the same element first. Make the change again if you still want it.'
);

/**
 * Sends the client what {@link AbstractHydraniumGlspState.onStatusChanged}
 * announces: the current status for its status overlay and the edit mode; and
 * a warning for each edit {@link AbstractHydraniumGlspState.onEditDropped}
 * announces.
 *
 * The only sender of the status and the edit mode. Either dispatched from
 * anywhere else is overwritten by the next change, and the state's account of
 * why the diagram is read-only no longer matches the client's. An
 * implementation bound in place of {@link DefaultDiagramStatusReporter} takes
 * over the dropped-edit warning too, or the client no longer hears of one.
 */
export interface DiagramStatusReporter extends ClientSessionInitializer {
   /**
    * The client switched itself to `editMode`, as GLSP's client does before it
    * forwards an edit-mode request. Sends the effective mode back if it differs.
    */
   clientEditModeChanged(editMode: EditMode): void;
}
export const DiagramStatusReporter = Symbol('DiagramStatusReporter');

@injectable()
export class DefaultDiagramStatusReporter implements DiagramStatusReporter, ClientSessionListener {
   @inject(ModelState) protected readonly state!: AbstractHydraniumGlspState<AstNode, unknown>;
   @inject(ActionDispatcher) protected readonly actionDispatcher!: ActionDispatcher;
   @inject(ClientSessionManager) protected readonly sessionManager!: ClientSessionManager;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   protected readonly toDispose = new DisposableCollection();
   /** What the client shows; it starts editable with an empty overlay. */
   protected sentStatus = statusKey(undefined);
   protected sentEditMode: string = EditMode.EDITABLE;

   initialize(): void {
      this.sessionManager.addListener(this, this.state.clientId);
      this.toDispose.push(this.state.onStatusChanged(() => this.send()));
      this.toDispose.push(this.state.onEditDropped(() => this.sendEditDropped()));
   }

   clientEditModeChanged(editMode: EditMode): void {
      this.sentEditMode = editMode;
      this.send();
   }

   protected send(): void {
      this.actionDispatcher
         .dispatchAll(this.changedActions())
         .catch((error: unknown) => this.state.logger.warn(`Could not send the diagram status: ${describeErrorWithStack(error)}`));
   }

   /**
    * Warn the client of a dropped edit. Not awaited: the drop is announced
    * inside the diagram's exclusive section, and a dispatch from outside any
    * action queues behind the action being processed, which may be waiting
    * for that section.
    */
   protected sendEditDropped(): void {
      const message = this.sharedServices.MessageRenderer.renderMessage(DIAGRAM_EDIT_DROPPED);
      this.actionDispatcher
         .dispatch(MessageAction.create(message, { severity: 'WARNING' }))
         .catch((error: unknown) => this.state.logger.warn(`Could not warn of a dropped edit: ${describeErrorWithStack(error)}`));
   }

   /** The actions that bring the client up to date, recording them as sent. */
   protected changedActions(): Action[] {
      const actions: Action[] = [];
      const current = this.state.currentStatus;
      if (statusKey(current) !== this.sentStatus) {
         this.sentStatus = statusKey(current);
         actions.push(
            current?.message === undefined
               ? // `NONE` is the client's spelling for "clear": an empty message at any
                 // other severity leaves an empty band with an icon on the canvas.
                 StatusAction.create('', { severity: 'NONE' })
               : StatusAction.create(current.message, { severity: current.severity ?? 'INFO' })
         );
      }
      if (this.state.editMode !== this.sentEditMode) {
         this.sentEditMode = this.state.editMode;
         actions.push(SetEditModeAction.create(this.state.editMode));
      }
      if (actions.length > 0) {
         this.state.logger.debug(
            `Sending status ${this.sentStatus} (from ${this.state.currentStatusSource ?? 'none'}); ` +
               `edit mode ${this.sentEditMode} (held by ${this.state.readonlyStatuses.join(', ') || 'none'})`
         );
      }
      return actions;
   }

   sessionDisposed(_clientSession: ClientSession): void {
      this.toDispose.dispose();
   }
}

function statusKey(entry: DiagramStatusEntry | undefined): string {
   return entry?.message === undefined ? 'none' : `${entry.severity ?? 'INFO'} "${entry.message}"`;
}
