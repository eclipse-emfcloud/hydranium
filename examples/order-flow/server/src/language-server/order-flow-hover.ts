/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { AstNode } from '@hydranium/langium';
import { AstNodeHoverProvider } from '@hydranium/langium/lsp';
import { type Field, isEntity, isEnumeration, isEnumLiteral, isField, isGateway, isProcessModel, isTask, isValueType } from './ast.js';

/**
 * Hover for all three order-flow grammars, as one provider.
 *
 * **Why the framework default is not enough here, and why that is not a
 * framework gap.** Langium's `MultilineCommentHoverProvider` answers with the
 * declaration's preceding comment, found by `findCommentNode` against
 * `GrammarConfig.multilineCommentRules` — which defaults to `ML_COMMENT` alone.
 * These three grammars comment with `//`, so the default provider resolves the
 * declaration correctly and then has nothing to say about it: the request
 * answers `null`, the client shows an empty hover, and the whole path looks
 * broken while every part of it works.
 *
 * A language whose declarations carry no doc comments has to say what a
 * declaration IS instead, which is what this does.
 *
 * **The base class resolves the DECLARATION, not the node under the cursor**, so
 * every entry below is reached from both directions for free: hovering
 * `for Order` in a `.process` file renders the `entity Order` in a `.domain`
 * one, through the same shared index the LSP head serves. That cross-grammar
 * hop is the property worth demonstrating, and it costs nothing here —
 * `AstNodeHoverProvider.getHoverContent` has already done it by the time
 * {@link getAstNodeHoverContent} is called.
 *
 * One class over three languages, like `OrderFlowSemanticTokenProvider`, and for
 * the same reason: the three grammars share one `AstReflection`, so a `$type`
 * dispatch is complete without either grammar knowing about the other's
 * provider.
 *
 * Returning `undefined` for an unmapped type is not a fallback to the comment
 * provider — the base calls this and nothing else — so anything worth hovering
 * needs an entry. `Transition`, `Read` and `Write` have none deliberately: they
 * declare no name, so the base resolves through them to whatever they reference
 * and this is never asked about them.
 */
export class OrderFlowHoverProvider extends AstNodeHoverProvider {
   protected override getAstNodeHoverContent(node: AstNode): string | undefined {
      if (isTask(node)) {
         // `_effectSummary` is a COMPUTED property, populated at
         // `ComputedScopes` by the AST-extension contribution — so this line is
         // the only place in the example where a derived property is visible to
         // a user. Absent rather than empty when the task has no effects.
         return `**task** \`${node.name}\`${node._effectSummary ? ` — ${node._effectSummary}` : ''}`;
      }
      if (isGateway(node)) {
         const branches = node.branches.map(branch => `\`${branch.label}\` → \`${branch.target.$refText}\``).join(', ');
         return `**gateway** \`${node.name}\`${branches ? ` — ${branches}` : ''}`;
      }
      if (isProcessModel(node)) {
         return `**process** \`${node.name}\` for \`${node.subject.$refText}\`, ${node.nodes.length} node(s)`;
      }
      if (isField(node)) {
         return `**field** \`${node.name}\`: ${describeFieldType(node)}`;
      }
      if (isEntity(node) || isValueType(node)) {
         const kind = isEntity(node) ? 'entity' : 'valuetype';
         const fields = node.fields.map(field => field.name).join(', ');
         return `${visibilityPrefix(node.visibility)}**${kind}** \`${node.name}\`${fields ? ` { ${fields} }` : ''}`;
      }
      if (isEnumeration(node)) {
         const literals = node.literals.map(literal => literal.name).join(', ');
         return `${visibilityPrefix(node.visibility)}**enum** \`${node.name}\` { ${literals} }`;
      }
      if (isEnumLiteral(node)) {
         return `**literal** \`${node.name}\` of \`${node.$container.name}\``;
      }
      return undefined;
   }
}

/**
 * The declared type of `field`, by reference TEXT rather than by the resolved
 * node's name.
 *
 * A field whose type does not resolve still has a type the author wrote, and
 * showing that is more useful on hover than showing nothing — this provider runs
 * on broken documents as readily as on valid ones.
 */
function describeFieldType(field: Field): string {
   return `\`${field.type.declared.$refText}\`${field.many ? '[]' : ''}`;
}

/**
 * `public ` for an exported declaration, nothing otherwise.
 *
 * Shown because visibility is what this example's two-project workspace exists
 * to demonstrate: the same hover tells a reader whether a declaration is
 * reachable from a dependent project at all.
 */
function visibilityPrefix(visibility: string | undefined): string {
   return visibility === undefined ? '' : `\`${visibility}\` `;
}
