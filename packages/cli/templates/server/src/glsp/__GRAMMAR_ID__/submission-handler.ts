// Submission handler for the __GRAMMAR__ diagram.
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
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';
import type { __GRAMMAR__GlspState } from './state.js';

@injectable()
export class __GRAMMAR__SubmissionHandler extends HydraniumGlspSubmissionHandler<__ENTRY_RULE__, FullTextSourceModel> {
   @inject(ModelState) declare protected modelState: __GRAMMAR__GlspState;

   protected override formatSourceRoot(root: __ENTRY_RULE__ | undefined): string {
      return root ? `__ENTRY_RULE__ nodes=${root.nodes.length}` : 'none';
   }
}
