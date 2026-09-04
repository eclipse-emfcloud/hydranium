/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { AstNode } from '@hydranium/langium';
import type { Mutable } from '@hydranium/protocol';

/**
 * Containment-array helpers for the `.process` operation handlers.
 *
 * **Why these are not one-line array pushes.** The framework's default
 * identity strategy is `NameBasedKeyProvider`, which keys an *unnamed* node —
 * a `Transition`, a gateway `Branch`, an `Effect` — from its position, as
 * `` `${$containerProperty}@${$containerIndex}` ``. A node appended with a bare
 * `array.push(node)` carries neither, so `getElementKey` returns `undefined`
 * and the GLSP index cannot produce an id for it at all. Every create handler
 * therefore has to stamp the Langium containment plumbing, and every delete
 * handler has to renumber what is left.
 *
 * That is a real constraint of the identity strategy rather than a quirk of
 * this example: any adopter creating unnamed elements from a diagram hits it.
 */

/**
 * Append `child` to `container[property]`, stamping the Langium containment
 * plumbing (`$container`, `$containerProperty`, `$containerIndex`) so the
 * positional key fallback can address it.
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
 * The renumbering matters because the positional key fallback encodes the
 * index: without it, deleting the first of three transitions leaves the other
 * two claiming indices 1 and 2 while sitting at 0 and 1, so any id derived
 * later in the same command addresses the wrong node.
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
