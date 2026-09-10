/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, type ValidationAcceptor, type ValidationChecks } from '@hydranium/langium';
import { defineMessage } from '@hydranium/protocol';
import { acceptMessage } from '../../messages/carriers.js';

export const SEPARATOR_IN_NAME = defineMessage(
   'hydranium/core/separator-in-name',
   "Name '{name}' contains the configured name separator '{separator}', which is reserved for qualified-name composition — use a different character."
);
import { type ServerLanguageServices } from '../language-module.js';
import { type ValidationCheckContribution, type ValidationCheckRegistry } from '../validation/validation-contribution.js';
import type { NameProvider } from './name-provider.js';

/**
 * Per-node validation check: flag name-bearing AST nodes whose name
 * value contains the configured name separator. Such values produce
 * silent ambiguity — once composed, a qualified name spanning several
 * nested nodes is indistinguishable from the literal name of one node.
 *
 * Polymorphic on {@link NameProvider.nameSeparator}: adopters that configure
 * a different separator get the corresponding check automatically. The rule
 * registers under `AstNode` so it fires for every node; nodes without a
 * name-bearing property are skipped by the check itself.
 *
 * This is a **validation** rule, not an **integrity** rule:
 * - Per-node syntactic check on a single AST node — no cross-document
 *   consistency dependency.
 * - Fires via Langium's `ValidationRegistry` at the validation phase.
 * - Integrity rules (in `IntegrityService`) run at the `Parsed` or
 *   `Linked` phase and reason about cross-document state.
 */
export function nameSeparatorCheck(nameProvider: NameProvider): (node: AstNode, accept: ValidationAcceptor) => void {
   return (node, accept) => {
      const ownName = nameProvider.getOwnName(node);
      if (typeof ownName !== 'string' || ownName.length === 0) {
         return;
      }
      const separator = nameProvider.nameSeparator;
      if (ownName.includes(separator)) {
         // `{ node }` rather than `{ node, property: 'name' }`: moving the
         // squiggle onto the name property is a behaviour change to the one
         // diagnostic every adopter receives by default, so it is decided on its
         // own merits rather than carried in by a mechanical migration.
         acceptMessage(accept, 'error', SEPARATOR_IN_NAME, { node }, { name: ownName, separator });
      }
   };
}

/**
 * Framework's own {@link ValidationCheckContribution} for {@link nameSeparatorCheck}.
 * Bound under `validation.checks.framework` in `createServerLanguageModule`,
 * so every adopter receives the name-separator validation out of the box —
 * no manual `registerValidationChecks` call needed.
 *
 * Adopters wanting narrower coverage can call {@link nameSeparatorCheck}
 * directly inside their own contribution and register the result against
 * the desired node types.
 */
export class NameSeparatorCheckContribution implements ValidationCheckContribution {
   protected readonly nameProvider: NameProvider;

   constructor(services: ServerLanguageServices) {
      this.nameProvider = services.references.NameProvider;
   }

   registerValidationChecks(registry: ValidationCheckRegistry): void {
      const checks: ValidationChecks<{ AstNode: AstNode }> = {
         AstNode: nameSeparatorCheck(this.nameProvider)
      };
      registry.register(checks);
   }
}
