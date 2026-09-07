/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { interfaces } from 'inversify';

/**
 * Create an Inversify service identifier for type `T`.
 *
 * Returns a fresh Symbol cast to Inversify's typed
 * {@link interfaces.ServiceIdentifier} shape. The cast is necessary
 * because TypeScript cannot infer the generic parameter from a Symbol
 * literal alone — Symbols carry no type information at the value level,
 * so `bind` and `@inject` would receive `any` without it. The cast lets
 * Inversify type-check the bound value at `bind(...).toConstantValue(x)`
 * sites and infer the field type at `@inject(...)` declarations.
 *
 * **Why a Symbol + cast, not a class or string token.**
 *
 * - **Class-as-token** doesn't work for interface-typed services —
 *   interfaces have no runtime value to bind against. Using a concrete
 *   class as the token would force adopters to extend that specific
 *   class rather than implement the interface.
 * - **String tokens** carry cross-package collision risk; two packages
 *   that independently bind the same name would clash in a shared
 *   container.
 * - **`Symbol.for(name)`** uses Node's cross-realm registry — that sharing
 *   is rarely needed, and it makes module-reload behaviour a foot-gun.
 *
 * Fresh `Symbol(description)` per token is the right primitive; this
 * helper centralises the cast so consumers don't repeat the
 * `as interfaces.ServiceIdentifier<T>` boilerplate at every binding
 * site declaration.
 *
 * Only the GLSP head uses Inversify, which is why this lives here; LSP /
 * data-server / `@hydranium/core` use Langium's plain constructor-arg DI
 * through the typed services tree, where binding tokens aren't needed. Adopters
 * mint a token per service they expose to their `@injectable()` GLSP components;
 * the framework's own are grouped in `HydraniumTypes` so token identity
 * stays decoupled from the implementation class name.
 */
export function serviceIdentifier<T>(description: string): interfaces.ServiceIdentifier<T> {
   return Symbol(description) as interfaces.ServiceIdentifier<T>;
}
