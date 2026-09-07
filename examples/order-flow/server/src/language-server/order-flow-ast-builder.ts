/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { makeAstNodeBuilder } from '@hydranium/core';
import { type OrderFlowAstType, reflection } from './generated/ast.js';

/**
 * AST-node factory pre-bound to order-flow's reflection and its generated
 * `OrderFlowAstType` registry, so call sites infer the node type from the type
 * constant alone:
 *
 * ```ts
 * const task = astNode(Task, { $container: root, name: 'Pick' });
 * //    ^^^^ inferred as Task
 * ```
 *
 * **Why this exists rather than object literals with casts.** The GLSP
 * operation handlers construct AST nodes, and the tempting shortcut is a
 * literal cast past the generated types. That loses exactly the checks worth
 * having: a missing mandatory field (`Transition.source`) and a containment
 * array left `undefined` both survive a cast and fail later — at serialization
 * or during the containment walk — where the cause is no longer visible. The
 * builder makes mandatory fields a type error and materialises grammar-declared
 * containment arrays (`Task.effects`, `Gateway.branches`) from reflection
 * metadata, so a freshly built task has `effects: []` rather than `undefined`.
 *
 * The `_`-prefixed AST-extension properties (`Task._writtenFields`,
 * `Task._effectSummary`) are declared optional and are recomputed at
 * `ComputedScopes`, so a builder call site never supplies them.
 *
 * **This spans every grammar deliberately.** `OrderFlowAstType` intersects the
 * `.domain`, `.process` and `.layout` type maps from the one `langium-cli` run,
 * so a single builder covers all of them — which is the same one-reflection
 * constraint the generated modules document.
 */
export const astNode = makeAstNodeBuilder<OrderFlowAstType>(reflection);
