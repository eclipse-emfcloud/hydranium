// Forwards the page's data channel to the port the servers extension answers
// under its host command.

import { createDataServerConnectionContainerModule, DataServerConnectionHandler } from '@hydranium/data-client-theia/node';
import { injectable } from '@theia/core/shared/inversify';
import { __CONFIG_ROOT_CONST___DATA_SERVER_HOST_COMMAND } from '__PROTOCOL_PACKAGE__';

@injectable()
export class __NAME__DataServerConnectionHandler extends DataServerConnectionHandler {
   constructor() {
      super({ portCommand: __CONFIG_ROOT_CONST___DATA_SERVER_HOST_COMMAND });
   }
}

export default createDataServerConnectionContainerModule(__NAME__DataServerConnectionHandler);
