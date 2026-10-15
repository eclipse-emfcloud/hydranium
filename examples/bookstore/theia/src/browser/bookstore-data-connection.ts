/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The page's one connection to the data head. Everything that reads the data
// head takes a session off it: Theia opens one channel per service path.

import { DataConnectionWithEvents } from '@hydranium/protocol';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { BookstoreElement } from '@hydranium/bookstore-protocol';
import { BookstoreDataPort } from './bookstore-data-port.js';

@injectable()
export class BookstoreDataConnection extends DataConnectionWithEvents<BookstoreElement> {
   // The constructor, not a field: the port is needed before `super` returns.
   constructor(@inject(BookstoreDataPort) port: BookstoreDataPort) {
      super(port);
   }
}
