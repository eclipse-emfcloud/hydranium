/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Containment-array maintenance for callers that build or delete AST nodes
 * programmatically — a GLSP operation handler being the usual one.
 *
 * **These live beside the key provider because the constraint is the key
 * provider's.** `NameBasedKeyProvider` keys a node the `NameProvider` gives no
 * name from its position, as `` `${$containerProperty}@${$containerIndex}` ``,
 * so a node appended with a bare `array.push` carries neither and
 * `getElementKey` answers `undefined` — the element has no key at all, and the
 * GLSP index cannot address it. Deleting from the middle of such a list must
 * renumber the survivors, or an id derived later in the same command names the
 * wrong node. Shipping the constraint's statement without the code that
 * discharges it leaves every adopter in that position re-deriving thirty lines
 * from prose, and both failures are silent.
 *
 * The population is narrower than "anyone creating elements from a diagram": it
 * takes a grammar with UNNAMED element types, programmatic creation or deletion
 * of them, and this key provider. A grammar whose diagram elements are all
 * named never reaches it, and the two ways out are named on the provider —
 * give the type a name, or bind a provider whose fallback is content-derived.
 *
 * **Free functions, and deliberately not a step on the AST builder.** Building a
 * node detached and appending it later is legitimate, so a containment step
 * cannot be mandatory; and an optional fluent step could not check the index
 * against the array unless it were handed the array, at which point it is these
 * signatures with more ceremony. `AstNodeInit` already accepts the three fields
 * for a caller who has them, which is the case these cover: it is the INDEX that
 * cannot be known without reading the array.
 */

import type { AstNode } from '@hydranium/langium';
import type { Mutable } from '@hydranium/protocol';

/**
 * Append `child` to `children`, stamping the Langium containment plumbing
 * (`$container`, `$containerProperty`, `$containerIndex`) so a positional key
 * can address it.
 *
 * `property` and `children` are separate parameters rather than one property
 * name the function dereferences: the array is what the index is derived from,
 * so taking it directly is what makes the two agree by construction instead of
 * by a lookup that a typo could point elsewhere.
 *
 * @returns `child`, so a caller can append and use it in one expression.
 */
export function appendChild<TChild extends AstNode>(container: AstNode, property: string, children: TChild[], child: TChild): TChild {
   const mutable = child as Mutable<TChild>;
   mutable.$container = container;
   mutable.$containerProperty = property;
   mutable.$containerIndex = children.length;
   children.push(child);
   return child;
}

/**
 * Remove every entry of `children` that is in `toRemove`, then renumber the
 * survivors' `$containerIndex`.
 *
 * Mutates `children` in place rather than returning a new array, because the
 * caller's array IS the AST's containment list — replacing the reference would
 * leave the parent pointing at the old one.
 *
 * @returns how many entries were removed, so a caller can tell a no-op delete
 * from one that changed the model without comparing lengths itself.
 */
export function removeChildren<TChild extends AstNode>(children: TChild[], toRemove: ReadonlySet<TChild>): number {
   if (toRemove.size === 0) {
      return 0;
   }
   const survivors = children.filter(child => !toRemove.has(child));
   const removed = children.length - survivors.length;
   children.length = 0;
   for (const [index, child] of survivors.entries()) {
      (child as Mutable<TChild>).$containerIndex = index;
      children.push(child);
   }
   return removed;
}
