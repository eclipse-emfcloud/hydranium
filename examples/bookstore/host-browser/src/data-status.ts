/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The data part of the page: one document read through the data head, out of
// the same store the other heads serve.

import { DataConnectionWithEvents, type DataPort } from '@hydranium/protocol';
import type { BookstoreElement } from '@hydranium/bookstore-protocol';

/** Open `uri` through the data head and say what it holds on the status line below the panes. */
export async function showDataStatus(port: DataPort, uri: string): Promise<void> {
   const session = new DataConnectionWithEvents<BookstoreElement>(port).createSession('bookstore-page');
   const opened = await session.openDocument({ uri });
   const line = document.getElementById('data-status') as HTMLElement;
   const file = uri.slice(uri.lastIndexOf('/') + 1);
   line.textContent = `data head: ${file} holds a ${opened.model?.root.$type ?? 'document with no model'}`;
   line.hidden = false;
}
