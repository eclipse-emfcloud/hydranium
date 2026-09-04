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
// `saveSourceModel` (through `ModelService.save` → the per-URI `Serializer` →
// the multi-client text store → `WritableFileSystemProvider`).
//
// The subclass exists so a bespoke load or save has a stable place to land.

import { type FullTextSourceModel, HydraniumGlspStorage } from '@hydranium/glsp-server';
import { injectable } from 'inversify';
import type { BookstoreModel } from '../../language-server/ast.js';

@injectable()
export class BookstoreGlspStorage extends HydraniumGlspStorage<BookstoreModel, FullTextSourceModel> {}
