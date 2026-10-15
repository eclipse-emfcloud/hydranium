// The page's one connection to the data head. Everything that reads the data
// head takes a session off it: Theia opens one channel per service path.

import { DataConnectionWithEvents } from '@hydranium/protocol';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { __NAME__Element } from '__PROTOCOL_PACKAGE__';
import { __NAME__DataPort } from './__PROJECT_ID__-data-port.js';

@injectable()
export class __NAME__DataConnection extends DataConnectionWithEvents<__NAME__Element> {
   // The constructor, not a field: the port is needed before `super` returns.
   constructor(@inject(__NAME__DataPort) port: __NAME__DataPort) {
      super(port);
   }
}
