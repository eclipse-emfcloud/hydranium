/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The GLSP client every diagram of this extension shares, as they share one
// server: the frontend module binds it once, and each diagram module skips it.

import { HydraniumGlspClientContribution } from '@hydranium/glsp-client-theia/browser';
import { injectable } from '@theia/core/shared/inversify';
import { BOOKSTORE_GLSP_CONTRIBUTION_ID } from '../common/bookstore-glsp-contribution.js';

@injectable()
export class BookstoreGlspClientContribution extends HydraniumGlspClientContribution {
   constructor() {
      super({ languageContributionId: BOOKSTORE_GLSP_CONTRIBUTION_ID });
   }
}
