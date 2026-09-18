/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Source-model storage for the Bookstore diagram, inheriting both framework
// defaults: `loadSourceModel` (open + settle + `setSourceRoot`) and
// `saveSourceModel` (flush the store's text for the primary and every tracked
// secondary through `AstDocumentManager.save` → `WritableFileSystemProvider`).
//
// No serializer runs on the save path — a save persists what the diagram's
// operations already wrote to the store.
//
// The subclass exists so a bespoke load or save has a stable place to land.

import { type FullTextSourceModel, HydraniumGlspStorage } from '@hydranium/glsp-server';
import { injectable } from 'inversify';
import type { BookstoreModel } from '../../language-server/ast.js';

@injectable()
export class BookstoreGlspStorage extends HydraniumGlspStorage<BookstoreModel, FullTextSourceModel> {}
