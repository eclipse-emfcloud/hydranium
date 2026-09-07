/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { IntegrityPhase, type IntegrityRule, type IntegrityRuleContribution, type IntegrityRuleRegistry } from '@hydranium/core';
import type { Logger } from '@hydranium/protocol';
import type { LangiumDocument } from '@hydranium/langium';
import { type DomainModel, type ProcessModel, isDomainModel, isProcessModel } from './ast.js';

/**
 * Deduplicate declaration names within a `.domain` document.
 *
 * Runs at `IntegrityPhase.Parsed`: references are not linked yet, but the AST
 * shape and identifier text are, which is exactly what a name-uniqueness rule
 * needs. Two declarations with the same name would otherwise both be exported
 * to the global index under one key, and which one a reference resolved to
 * would depend on emit order.
 *
 * Suffixing rather than reporting is deliberate — an integrity rule *repairs*
 * the tree so downstream phases see a consistent model; reporting to the user
 * is a validation check's job. The `__n` scheme is crude on purpose; a real
 * language would want a configurable strategy.
 */
export class UniqueDeclarationNamesRule implements IntegrityRule<DomainModel> {
   readonly id = 'unique-declaration-names';
   readonly label = 'Unique Declaration Names';
   readonly nodeType = 'DomainModel';
   readonly phase = IntegrityPhase.Parsed;

   enforce(node: DomainModel, _document: LangiumDocument, logger: Logger): boolean {
      if (!isDomainModel(node)) {
         return false;
      }
      const seen = new Map<string, number>();
      let mutated = false;
      for (const declaration of node.declarations) {
         const occurrence = seen.get(declaration.name) ?? 0;
         seen.set(declaration.name, occurrence + 1);
         if (occurrence > 0) {
            const suffixed = `${declaration.name}__${occurrence}`;
            logger.info(`Renaming duplicate declaration '${declaration.name}' to '${suffixed}'`);
            declaration.name = suffixed;
            mutated = true;
         }
      }
      return mutated;
   }
}

/**
 * Same rule for the `.process` grammar's flow nodes, and the reason the
 * integrity tier is worth binding on that language too: tasks and gateways
 * share one name space (a `Transition` targets `FlowNode`), so a duplicate
 * makes a transition ambiguous rather than merely odd.
 *
 * Registered against a different `nodeType`, which is what the framework
 * dispatches on — so the two rules never see each other's documents even
 * though the `.domain` and `.process` languages bind the same contribution.
 */
export class UniqueFlowNodeNamesRule implements IntegrityRule<ProcessModel> {
   readonly id = 'unique-flow-node-names';
   readonly label = 'Unique Flow Node Names';
   readonly nodeType = 'ProcessModel';
   readonly phase = IntegrityPhase.Parsed;

   enforce(node: ProcessModel, _document: LangiumDocument, logger: Logger): boolean {
      if (!isProcessModel(node)) {
         return false;
      }
      const seen = new Map<string, number>();
      let mutated = false;
      for (const flowNode of node.nodes) {
         const occurrence = seen.get(flowNode.name) ?? 0;
         seen.set(flowNode.name, occurrence + 1);
         if (occurrence > 0) {
            const suffixed = `${flowNode.name}__${occurrence}`;
            logger.info(`Renaming duplicate flow node '${flowNode.name}' to '${suffixed}'`);
            flowNode.name = suffixed;
            mutated = true;
         }
      }
      return mutated;
   }
}

/**
 * Both rules, bound under `integrity.rules` in `order-flow-module.ts`.
 *
 * Binding the tier is as much the point as the rules are: it is what makes the
 * framework run a real rule, against a real grammar, inside a real build cycle.
 *
 * One behaviour to know before binding your own: `IntegrityService`'s default
 * `'silent'` sync mode PERSISTS a repair — `FileSystemProvider.writeFile` on
 * closed documents, with text from the serializer, so comments do not survive.
 * Bind the service with an explicit `syncMode` if that is not what you want.
 */
export class OrderFlowIntegrityContribution implements IntegrityRuleContribution {
   registerIntegrityRules(registry: IntegrityRuleRegistry): void {
      registry.register(new UniqueDeclarationNamesRule());
      registry.register(new UniqueFlowNodeNamesRule());
   }
}
