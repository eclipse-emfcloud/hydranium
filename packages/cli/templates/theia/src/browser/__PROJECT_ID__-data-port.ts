// The page's end of the data head: a channel to the backend, which forwards it
// to the port the servers extension answers.

import { ChannelDataPort } from '@hydranium/data-client-theia/browser';
import { DATA_SERVER_PATH } from '@hydranium/protocol';
import { injectable } from '@theia/core/shared/inversify';

@injectable()
export class __NAME__DataPort extends ChannelDataPort {
   protected readonly servicePath = DATA_SERVER_PATH;
}
