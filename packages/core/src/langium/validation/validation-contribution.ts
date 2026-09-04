/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ValidationCategory, type ValidationChecks } from '@hydranium/langium';

/**
 * Registry handed to a {@link ValidationCheckContribution}. A thin wrapper over
 * Langium's `ValidationRegistry.register` — the same type-keyed,
 * category-scheduled check map underneath, so two contributions registering a
 * check for the same node type both run (the registry stores checks in a
 * `MultiMap`, which appends).
 *
 * `thisObj` mirrors Langium's signature: when a contribution passes check
 * methods that read `this`, hand the contribution instance here so the binding
 * is preserved.
 */
export interface ValidationCheckRegistry {
   register<T>(checks: ValidationChecks<T>, thisObj?: ThisParameterType<unknown>, category?: ValidationCategory): void;
}

/**
 * Declarative registration of validation checks. Bound under the module's
 * `validation.checks` contribution group; a framework collector reads the group
 * and calls this method, handing in a {@link ValidationCheckRegistry} that
 * forwards to Langium's `ValidationRegistry`.
 *
 * The domain-qualified method name lets a single cross-cutting class implement
 * several contribution interfaces without method collision.
 */
export interface ValidationCheckContribution {
   registerValidationChecks(registry: ValidationCheckRegistry): void;
}
