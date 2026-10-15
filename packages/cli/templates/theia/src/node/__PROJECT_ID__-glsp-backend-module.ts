// Forwards the page's GLSP channel to the port the servers extension answers
// under its host command.

import { createGlspConnectionContainerModule, GlspServerConnectionHandler } from '@hydranium/glsp-client-theia/node';
import { injectable } from '@theia/core/shared/inversify';
import { __CONFIG_ROOT_CONST___GLSP_SERVER_HOST_COMMAND } from '__PROTOCOL_PACKAGE__';
import { __CONFIG_ROOT_CONST___GLSP_CONTRIBUTION_ID } from '../common/__PROJECT_ID__-glsp-contribution.js';

@injectable()
export class __NAME__GlspConnectionHandler extends GlspServerConnectionHandler {
   constructor() {
      super({ languageContributionId: __CONFIG_ROOT_CONST___GLSP_CONTRIBUTION_ID, portCommand: __CONFIG_ROOT_CONST___GLSP_SERVER_HOST_COMMAND });
   }
}

export default createGlspConnectionContainerModule(__NAME__GlspConnectionHandler);
