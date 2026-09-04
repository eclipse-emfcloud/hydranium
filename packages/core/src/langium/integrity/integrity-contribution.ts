/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode } from '@hydranium/langium';
import { type Disposable } from 'vscode-languageserver';
import { type IntegrityRule } from './integrity-rule.js';

/**
 * Registry handed to an {@link IntegrityRuleContribution}. Implemented by the
 * integrity service; a contribution receives it and registers one or many
 * rules. Doubles as the low-level imperative API for the rare runtime-dynamic
 * registration case.
 *
 * `register` is generic PER CALL, matching `AstExtensionRegistry` and
 * `ValidationCheckRegistry`: a rule declares the node type it enforces against
 * (`IntegrityRule<TypeOne>`), and pinning the parameter to the `AstNode`
 * default would widen every rule at the door. That widening is accepted by
 * method-parameter bivariance rather than rejected, so it costs no cast and
 * reads as fine — which is exactly why it is worth stating: the rule's own
 * node type stays visible at the registration site instead of being erased.
 */
export interface IntegrityRuleRegistry {
   register<T extends AstNode>(rule: IntegrityRule<T>): Disposable;
}

/**
 * Declarative registration of integrity rules. Bound under the module's
 * `integrity.rules` contribution group; the integrity service reads its own
 * group at construction and calls this method, handing itself in as the
 * registry.
 *
 * The domain-qualified method name lets a single cross-cutting class implement
 * several contribution interfaces (e.g. also `ValidationCheckContribution`)
 * without method collision — bind it once and reference it from each group.
 */
export interface IntegrityRuleContribution {
   registerIntegrityRules(registry: IntegrityRuleRegistry): void;
}
