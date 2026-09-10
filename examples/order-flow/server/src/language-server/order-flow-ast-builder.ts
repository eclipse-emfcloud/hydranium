/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Order-flow's AST-node factories, re-exported from the generated bindings so
 * call sites infer the node type from the type constant alone:
 *
 * ```ts
 * const task = processNode(Task, { $container: root, name: 'Pick' });
 * //    ^^^^ inferred as Task
 * ```
 *
 * **Why a builder rather than object literals with casts.** The GLSP operation
 * handlers construct AST nodes, and the tempting shortcut is a literal cast past
 * the generated types. That loses exactly the checks worth having: a missing
 * mandatory field (`Transition.source`) and a containment array left `undefined`
 * both survive a cast and fail later — at serialization or during the
 * containment walk — where the cause is no longer visible. The builder makes
 * mandatory fields a type error and materialises grammar-declared containment
 * arrays (`Task.effects`, `Gateway.branches`) from reflection metadata, so a
 * freshly built task has `effects: []` rather than `undefined`.
 *
 * **Why this module exists at all, rather than importing the generated file.**
 * The bindings are generated, but this prose is order-flow's: the
 * `_`-prefixed AST-extension properties (`Task._writtenFields`,
 * `Task._effectSummary`) are declared optional and recomputed at
 * `ComputedScopes`, so a builder call site never supplies them — a constraint
 * that holds for this grammar and no other. Keeping it here leaves the emitted
 * header saying only what is true for every adopter.
 *
 * **Which binding to reach for.** `processNode` / `layoutNode` / `domainNode`
 * name the grammar the call site works in; `astNode` spans all three. Note that
 * order-flow's grammars nest — `Layout` imports `Process`, which imports
 * `Domain` — and a per-grammar type map lists everything REACHABLE from that
 * grammar. So `layoutNode` accepts exactly what `astNode` does, and only
 * `domainNode` and `processNode` reject anything. The narrower name is still
 * worth writing: it records which grammar the handler belongs to, and it starts
 * rejecting the moment the grammars stop nesting.
 */
export { astNode, domainNode, layoutNode, processNode } from './generated-hydranium/ast-builder.js';
