/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNodeDescription, type Scope, type Stream } from '@hydranium/langium';

/**
 * A scope that answers from `primary`, and from `fallback` only for a name
 * `primary` does not hold.
 *
 * Langium fixes a scope's outer scope when the scope is built, so a tier cannot
 * be put below a scope that already exists, such as a cached one. Re-wrapping
 * that scope's elements instead would turn its keyed lookup into a scan of
 * every element; chaining keeps each scope's own lookup.
 */
export class FallbackScope implements Scope {
   constructor(
      protected readonly primary: Scope,
      protected readonly fallback: Scope
   ) {}

   getElement(name: string): AstNodeDescription | undefined {
      return this.primary.getElement(name) ?? this.fallback.getElement(name);
   }

   getElements(name: string): Stream<AstNodeDescription> {
      return this.primary.getElements(name).concat(this.fallback.getElements(name));
   }

   getAllElements(): Stream<AstNodeDescription> {
      return this.primary.getAllElements().concat(this.fallback.getAllElements());
   }
}
