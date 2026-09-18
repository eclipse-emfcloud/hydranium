/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumGlspStorage } from '@hydranium/glsp-server';
import { injectable } from 'inversify';
import type { ProcessModel } from '../language-server/ast.js';
import type { OrderFlowSourceModel } from './order-flow-glsp-state.js';

/**
 * `.process` source-model storage, inheriting both framework defaults:
 * `loadSourceModel` (open + settle + `setSourceRoot`) and `saveSourceModel`
 * (flush the store's text for the primary and every tracked secondary through
 * `AstDocumentManager.save` → `WritableFileSystemProvider`).
 *
 * No serializer runs on the save path — a save persists what the diagram's
 * operations already wrote to the store. Serialization happens per operation, on
 * the update path, where `OrderFlowGlspState.persist` reaches the per-URI
 * `Serializer`: one is bound per grammar, and a multi-grammar adopter has to
 * reach the `.process` one rather than whichever was registered last.
 */
@injectable()
export class OrderFlowGlspStorage extends HydraniumGlspStorage<ProcessModel, OrderFlowSourceModel> {}
