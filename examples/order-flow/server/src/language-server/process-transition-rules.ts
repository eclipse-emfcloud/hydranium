/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { FlowNode, ProcessModel, Transition } from './ast.js';

/**
 * What makes a `transition a -> b` well-formed, in one place.
 *
 * **Three callers, and they must not be able to disagree.** The rules are asked
 * by the diagram's `EdgeCreationChecker` (so the cursor says no before the drop),
 * by the create-transition operation handler (so a client that ignores the type
 * hints still cannot write one), and by the `.process` validator (so a
 * hand-edited file reports the same thing). A diagram that refuses what the text
 * accepts is a split contract, and the split is invisible until someone hits it
 * from the other side.
 *
 * Deliberately free functions over the AST rather than a service: they read
 * nothing but their arguments, which is what lets the GLSP tier and the language
 * tier share them without either owning the other.
 */

/**
 * A transition from a flow node to itself.
 *
 * The grammar permits it — both ends are just `[FlowNode:ID]` — and it says
 * nothing: a step whose successor is itself either never advances or is a
 * self-loop the notation has no way to distinguish from a mistake.
 */
export function isSelfTransition(source: FlowNode, target: FlowNode): boolean {
   return source === target;
}

/**
 * The first transition already joining `source` to `target`, if any.
 *
 * Identity comparison on the RESOLVED nodes rather than on reference text, so
 * two spellings of the same name (or a name that resolves through the global
 * index from another document) still count as the same pair. An unresolved
 * endpoint matches nothing — a broken reference is its own diagnostic, and
 * treating `undefined === undefined` as a duplicate would report every pair of
 * broken transitions as clashing with each other.
 */
export function findTransition(root: ProcessModel, source: FlowNode, target: FlowNode): Transition | undefined {
   return root.transitions.find(transition => transition.source?.ref === source && transition.target?.ref === target);
}

/**
 * Whether `source -> target` may be added to `root`.
 *
 * The composite the diagram asks, so a new rule lands in one place rather than
 * in each caller's own conjunction.
 */
export function canAddTransition(root: ProcessModel, source: FlowNode, target: FlowNode): boolean {
   return !isSelfTransition(source, target) && findTransition(root, source, target) === undefined;
}
