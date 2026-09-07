/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
   DataClientProtocol,
   Project,
   ProjectsChangedEvent,
   TransferDiagnostic,
   TransferDocumentSavedEvent,
   TransferDocumentUpdatedEvent,
   TransferElement
} from '@hydranium/protocol';
import { Emitter, type Event } from '@theia/core';

/**
 * Default {@link DataClientProtocol} implementation for a Theia frontend:
 * each inbound `on*` notification is fanned out to a Theia {@link Event} so
 * multiple local listeners can subscribe (the framework deliberately leaves
 * fan-out to the consumer — see `DataClientProtocol`).
 *
 * Bind an instance as the `localTarget` of the frontend's `createRpcProxy`
 * (with `DATA_CLIENT_PROTOCOL_METHODS` as `localMethods`); incoming
 * `<namespace>onDocumentUpdated` etc. dispatch to the matching method here,
 * which fires the paired `Event`.
 *
 * Adopters subclass to add signals that are not wire notifications, or to
 * expose domain-renamed aliases of these channels — the event getters stay
 * accessible to the subclass.
 */
export class EmitterDataClient<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project
> implements DataClientProtocol<TTransfer, TDiagnostic, TProject> {
   protected readonly onDocumentUpdatedEmitter = new Emitter<TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>>();
   /** Fires for each inbound {@link onDocumentUpdated} notification. */
   readonly onDidUpdateDocument: Event<TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>> = this.onDocumentUpdatedEmitter.event;

   protected readonly onDocumentSavedEmitter = new Emitter<TransferDocumentSavedEvent<TTransfer, TDiagnostic>>();
   /** Fires for each inbound {@link onDocumentSaved} notification. */
   readonly onDidSaveDocument: Event<TransferDocumentSavedEvent<TTransfer, TDiagnostic>> = this.onDocumentSavedEmitter.event;

   protected readonly onProjectsChangedEmitter = new Emitter<ProjectsChangedEvent<TProject>>();
   /** Fires for each inbound {@link onProjectsChanged} notification. */
   readonly onDidChangeProjects: Event<ProjectsChangedEvent<TProject>> = this.onProjectsChangedEmitter.event;

   onDocumentUpdated(event: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>): void {
      this.onDocumentUpdatedEmitter.fire(event);
   }

   onDocumentSaved(event: TransferDocumentSavedEvent<TTransfer, TDiagnostic>): void {
      this.onDocumentSavedEmitter.fire(event);
   }

   onProjectsChanged(event: ProjectsChangedEvent<TProject>): void {
      this.onProjectsChangedEmitter.fire(event);
   }
}
