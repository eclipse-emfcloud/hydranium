/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, type Event } from 'vscode-jsonrpc';
import type { DataClientProtocol, ProjectsChangedEvent, TransferDocumentSavedEvent, TransferDocumentUpdatedEvent } from '../data';
import type { Project } from '../project';
import type { TransferDiagnostic } from '../transfer-diagnostic';
import type { TransferElement } from '../transfer-element';

/**
 * The inbound half of a data connection, fanned out to local listeners.
 *
 * A connection has exactly one `DataClientProtocol` bound to it, so whoever
 * that is becomes the only thing able to see server pushes. That does not suit
 * a host with more than one interested party — a properties panel, a tree, a
 * status contribution — so this sits in the slot instead and re-emits.
 *
 * The `on*` methods are the WIRE names, matched against
 * `DATA_CLIENT_PROTOCOL_METHODS`; the `onDid*` events are the local ones.
 * Keeping the two sets of names distinct is what makes it obvious which side of
 * the boundary a given member belongs to.
 *
 * **Relationship to `@hydranium/data-client-theia`'s `EmitterDataClient`: two
 * host flavours of one idea, not a duplicate to be collapsed.** The difference
 * is the event type: `EmitterDataClient` fans out to a `@theia/core` `Event`,
 * which is what a Theia frontend's `@injectable()` client wants, while this one
 * uses vscode-jsonrpc's and is therefore usable from a webview or a plain
 * browser client too. Pick by host; neither is deprecated.
 */
export class DataEvents<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TProject extends Project = Project
> implements DataClientProtocol<TTransfer, TDiagnostic, TProject> {
   protected readonly documentUpdatedEmitter = new Emitter<TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>>();
   protected readonly documentSavedEmitter = new Emitter<TransferDocumentSavedEvent<TTransfer, TDiagnostic>>();
   protected readonly projectsChangedEmitter = new Emitter<ProjectsChangedEvent<TProject>>();

   /** A build-phase event for a watched document. Carries the originating `sourceClientId`. */
   readonly onDidUpdateDocument: Event<TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>> = this.documentUpdatedEmitter.event;
   /** A watched document was persisted to disk. */
   readonly onDidSaveDocument: Event<TransferDocumentSavedEvent<TTransfer, TDiagnostic>> = this.documentSavedEmitter.event;
   /** The project set changed. */
   readonly onDidChangeProjects: Event<ProjectsChangedEvent<TProject>> = this.projectsChangedEmitter.event;

   // --- DataClientProtocol (wire names) ---

   onDocumentUpdated(event: TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>): void {
      this.documentUpdatedEmitter.fire(event);
   }

   onDocumentSaved(event: TransferDocumentSavedEvent<TTransfer, TDiagnostic>): void {
      this.documentSavedEmitter.fire(event);
   }

   onProjectsChanged(event: ProjectsChangedEvent<TProject>): void {
      this.projectsChangedEmitter.fire(event);
   }

   dispose(): void {
      this.documentUpdatedEmitter.dispose();
      this.documentSavedEmitter.dispose();
      this.projectsChangedEmitter.dispose();
   }
}
