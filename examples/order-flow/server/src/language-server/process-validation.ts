/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ValidationCheckContribution, ValidationCheckRegistry } from '@hydranium/core';
import type { ValidationAcceptor } from '@hydranium/langium';
import type { OrderFlowAstType, Transition } from './ast.js';
import { findTransition, isSelfTransition } from './process-transition-rules.js';

/**
 * Validation for the `.process` grammar's transitions.
 *
 * **The text half of a rule the diagram also enforces.** The diagram's
 * `EdgeCreationChecker` refuses these two shapes before the drop and the
 * operation handler refuses them again on the wire, but neither can see a file
 * someone typed. Without this contribution the diagram would forbid what the
 * editor accepts, which reads as the diagram being broken rather than the model
 * being wrong; see `process-transition-rules.ts`, which all three share so they
 * cannot drift apart.
 *
 * Registered through the framework's `validation.checks` contribution group
 * rather than by rebinding Langium's `ValidationRegistry`, so it composes with
 * any other contribution for the same node type — the registry stores checks in
 * a `MultiMap`, so both run.
 *
 * Errors rather than warnings, for both. Each denotes a model that cannot mean
 * anything: a step whose successor is itself never advances, and a repeated pair
 * adds no edge the first one did not already assert. Neither is a style
 * preference the author might reasonably disagree with.
 */
export class OrderFlowProcessValidationContribution implements ValidationCheckContribution {
   registerValidationChecks(registry: ValidationCheckRegistry): void {
      // Keyed on `Transition` rather than on `ProcessModel`, so the diagnostic
      // range is the offending transition instead of the whole file.
      registry.register<OrderFlowAstType>({ Transition: this.checkTransition }, this);
   }

   protected checkTransition(transition: Transition, accept: ValidationAcceptor): void {
      const source = transition.source?.ref;
      const target = transition.target?.ref;
      if (!source || !target) {
         // An endpoint that does not resolve already reports as a linking error
         // at a precise range; adding a second diagnostic for the same typo
         // would be noise.
         return;
      }
      if (isSelfTransition(source, target)) {
         accept('error', `'${source.name}' cannot transition to itself.`, { node: transition, property: 'target' });
         return;
      }
      // Reported on the LATER of the pair: `findTransition` returns the first
      // match, so a transition that finds something other than itself is the
      // duplicate. Reporting both would blame the original for the copy.
      const existing = findTransition(transition.$container, source, target);
      if (existing && existing !== transition) {
         accept('error', `A transition from '${source.name}' to '${target.name}' is already declared.`, {
            node: transition
         });
      }
   }
}
