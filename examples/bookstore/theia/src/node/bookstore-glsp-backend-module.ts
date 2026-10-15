/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Forwards the page's GLSP channel to the port the servers extension answers
// under its host command.

import { createGlspConnectionContainerModule, GlspServerConnectionHandler } from '@hydranium/glsp-client-theia/node';
import { injectable } from '@theia/core/shared/inversify';
import { BOOKSTORE_GLSP_SERVER_HOST_COMMAND } from '@hydranium/bookstore-protocol';
import { BOOKSTORE_GLSP_CONTRIBUTION_ID } from '../common/bookstore-glsp-contribution.js';

@injectable()
export class BookstoreGlspConnectionHandler extends GlspServerConnectionHandler {
   constructor() {
      super({ languageContributionId: BOOKSTORE_GLSP_CONTRIBUTION_ID, portCommand: BOOKSTORE_GLSP_SERVER_HOST_COMMAND });
   }
}

export default createGlspConnectionContainerModule(BookstoreGlspConnectionHandler);
