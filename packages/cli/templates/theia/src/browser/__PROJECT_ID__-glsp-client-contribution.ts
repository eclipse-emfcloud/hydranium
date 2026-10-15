// The GLSP client every diagram of this extension shares, as they share one
// server: the frontend module binds it once, and each diagram module skips it.

import { HydraniumGlspClientContribution } from '@hydranium/glsp-client-theia/browser';
import { injectable } from '@theia/core/shared/inversify';
import { __CONFIG_ROOT_CONST___GLSP_CONTRIBUTION_ID } from '../common/__PROJECT_ID__-glsp-contribution.js';

@injectable()
export class __NAME__GlspClientContribution extends HydraniumGlspClientContribution {
   constructor() {
      super({ languageContributionId: __CONFIG_ROOT_CONST___GLSP_CONTRIBUTION_ID });
   }
}
