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
 * (through `ModelService.save` → the per-URI `Serializer` → the multi-client
 * text store → `WritableFileSystemProvider`).
 *
 * The per-URI resolution matters more here than in a single-grammar adopter: a
 * serializer is bound per grammar, and the save flow has to reach the `.process`
 * one rather than whichever was registered last.
 */
@injectable()
export class OrderFlowGlspStorage extends HydraniumGlspStorage<ProcessModel, OrderFlowSourceModel> {}
