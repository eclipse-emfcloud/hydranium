/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultCommandStack, ModelState } from '@eclipse-glsp/server';
import { type ServerSharedServices } from '@hydranium/core';
import { inject, injectable } from 'inversify';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';

/**
 * GLSP's command stack with the diagram's dirty state read from the text store:
 * dirty while any document the diagram's client session has open differs from
 * its file, as the store last knew the file. Undo and redo are GLSP's.
 *
 * GLSP's own answer counts the diagram's commands since its last save, so it
 * misses every change the diagram did not make: another client's unsaved edit
 * leaves it clean, and a save it did not make of a document other than the
 * diagram's own leaves it dirty. Every `SetDirtyStateAction` GLSP sends reads
 * this answer.
 */
@injectable()
export class HydraniumGlspCommandStack extends DefaultCommandStack {
   @inject(ModelState) protected readonly modelState!: ModelState;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   override get isDirty(): boolean {
      const textDocuments = this.sharedServices.workspace.TextDocuments;
      const clientId = this.modelState.clientId;
      return textDocuments.openDocuments().some(open => open.clients.includes(clientId) && textDocuments.isDirty(open.uri));
   }
}
