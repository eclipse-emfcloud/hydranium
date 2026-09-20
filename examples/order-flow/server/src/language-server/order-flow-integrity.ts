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
import type { LangiumDocument, NamedAstNode } from '@hydranium/langium';
import { type DomainModel, type ProcessModel, isDomainModel, isProcessModel } from './ast.js';

/** A `__n` this rule appended, stripped back off so repairs count up instead of nesting. */
const REPAIR_SUFFIX = /__\d+$/;

/**
 * Rename every entry that repeats a name an earlier one holds, to the lowest
 * `__n` free across the whole list. Returns `true` if anything was renamed.
 *
 * **A rule gets one pass per build**: the integrity tier re-serialises and
 * re-parses a repair, but does not re-run the rules against the result. So a
 * repair must not mint a name the document already carries — the collision it
 * would leave behind survives until some later edit drives the next build,
 * which an editor shows as a duplicated line that only settles on save. Hence a
 * taken set seeded before the first rename, rather than a per-name occurrence
 * count: the latter hands the third entry of `Pay`, `Pay__1`, `Pay` the name
 * `Pay__1` a second time, and that list is what duplicating a line beside its
 * own earlier repair produces.
 *
 * **The stem is stripped of a trailing `__n` before counting**, so duplicating
 * an already-repaired line yields `Pay__2` rather than a `Pay__1__1` that grows
 * a segment per copy. The cost is that a name ending in `__n` in the source is
 * read as a stem plus a suffix, and a duplicate of it is renamed from the stem.
 */
function deduplicateNames(named: readonly NamedAstNode[], kind: string, logger: Logger): boolean {
   const taken = new Set(named.map(entry => entry.name));
   const seen = new Set<string>();
   let mutated = false;
   for (const entry of named) {
      if (!seen.has(entry.name)) {
         seen.add(entry.name);
         continue;
      }
      const stem = entry.name.replace(REPAIR_SUFFIX, '');
      let suffix = 1;
      while (taken.has(`${stem}__${suffix}`)) {
         suffix++;
      }
      const renamed = `${stem}__${suffix}`;
      logger.info(`Renaming duplicate ${kind} '${entry.name}' to '${renamed}'`);
      entry.name = renamed;
      taken.add(renamed);
      seen.add(renamed);
      mutated = true;
   }
   return mutated;
}

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
      return deduplicateNames(node.declarations, 'declaration', logger);
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
      return deduplicateNames(node.nodes, 'flow node', logger);
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
