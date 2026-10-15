/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Forwards the page's data channel to the port the servers extension answers
// under its host command.

import { createDataServerConnectionContainerModule, DataServerConnectionHandler } from '@hydranium/data-client-theia/node';
import { injectable } from '@theia/core/shared/inversify';
import { BOOKSTORE_DATA_SERVER_HOST_COMMAND } from '@hydranium/bookstore-protocol';

@injectable()
export class BookstoreDataServerConnectionHandler extends DataServerConnectionHandler {
   constructor() {
      super({ portCommand: BOOKSTORE_DATA_SERVER_HOST_COMMAND });
   }
}

export default createDataServerConnectionContainerModule(BookstoreDataServerConnectionHandler);
