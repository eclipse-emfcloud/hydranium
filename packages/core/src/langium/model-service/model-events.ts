/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri } from '@hydranium/protocol';
import { type AstNode, type DocumentState } from '@hydranium/langium';
import { type AstDocumentSavedEvent, type AstDocumentUpdatedEvent } from '../../documents/ast-document-manager.js';
import { type DocumentDirtyChangedEvent } from '../../documents/dirty-state-tracker.js';
import { type DocumentReleasedEvent } from '../../documents/hydranium-text-documents.js';
import { type AstDiagnostic } from '../validation/document-validator.js';

/** Which documents a `ModelService` subscription hears about. */
export interface ModelEventFilter {
   /** One document, in any spelling; matched by canonical form. Absent for every document. */
   readonly uri?: string;
}

/** A {@link ModelEventFilter} for an event a build phase fires. */
export interface ModelPhaseFilter extends ModelEventFilter {
   /** Defaults to `Validated`. */
   readonly phase?: DocumentState;
}

/**
 * A document reaching {@link phase} in a build.
 *
 * `document` holds for the listener's synchronous run: its root is the one the
 * build carried to the phase, and at `Validated` its diagnostics are that
 * build's, copied. A later build can unlink that root in place or replace it,
 * so a listener that awaits first reads the document again through the phase
 * reads or `snapshot`.
 *
 * Below `Validated` the document carries no diagnostics: any it held would be
 * an earlier build's.
 */
export interface ModelUpdatedEvent<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> extends AstDocumentUpdatedEvent<
   TAst,
   TDiagnostic
> {
   readonly phase: DocumentState;
}

/**
 * The documents one build carried to {@link phase}. Not fired for a cancelled
 * build, so a document it built shows up in the build that takes over.
 */
export interface ModelsBuiltEvent {
   readonly uris: readonly CanonicalUri[];
   readonly phase: DocumentState;
}

/**
 * A document's file was removed. No build reaches a deleted document, so no
 * {@link ModelUpdatedEvent} reports it.
 */
export interface ModelDeletedEvent {
   readonly uri: CanonicalUri;
}

/** A document was saved: the AST manager's event, as `ModelService` hands it out. */
export type ModelSavedEvent<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> = AstDocumentSavedEvent<
   TAst,
   TDiagnostic
>;

/** A document's text started or stopped differing from its file: the store's event, as `ModelService` hands it out. */
export type ModelDirtyChangedEvent = DocumentDirtyChangedEvent;

/** A document no client has open any more was released: the store's event, as `ModelService` hands it out. */
export type ModelReleasedEvent = DocumentReleasedEvent;
