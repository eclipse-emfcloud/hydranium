/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Submission handler for the Bookstore diagram.
//
// Inherits the framework's `readyEvent = IntegrityService.SettledState`, which
// is load-bearing rather than incidental: the GModel factory resolves
// `target.ref`, so it needs a fully-linked AST. Without the gate those reads
// fire mid-build and warn about resolution before scopes are computed.
//
// Only `formatSourceRoot` is overridden, so the submit log names the model and
// its node count instead of a bare `$type`.

import { ModelState } from '@eclipse-glsp/server';
import { type FullTextSourceModel, HydraniumGlspSubmissionHandler } from '@hydranium/glsp-server';
import { inject, injectable } from 'inversify';
import type { BookstoreModel } from '../../language-server/ast.js';
import type { BookstoreGlspState } from './state.js';

@injectable()
export class BookstoreSubmissionHandler extends HydraniumGlspSubmissionHandler<BookstoreModel, FullTextSourceModel> {
   @inject(ModelState) declare protected modelState: BookstoreGlspState;

   protected override formatSourceRoot(root: BookstoreModel | undefined): string {
      return root ? `BookstoreModel nodes=${root.nodes.length}` : 'none';
   }
}
