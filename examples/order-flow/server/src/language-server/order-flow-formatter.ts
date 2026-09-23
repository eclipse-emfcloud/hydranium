/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode } from '@hydranium/langium';
import { AbstractFormatter, Formatting } from '@hydranium/langium/lsp';
import {
   isDiagramNode,
   isDomainModel,
   isEntity,
   isEnumeration,
   isGateway,
   isLayoutModel,
   isProcessModel,
   isTask,
   isValueType
} from './ast.js';

/**
 * `textDocument/formatting` for all three order-flow grammars, as one formatter.
 *
 * Formatting and serializing are different jobs, and this example keeps them
 * apart deliberately: a serializer turns a model into text with no prior file to
 * consult, a formatter rewrites text the author already has.
 *
 * **Do not call this from a write path.** It answers an explicit formatting
 * request, or the client's own format-on-save. Running it on a diagram gesture
 * or an integrity repair reflows lines the user never asked to touch, and
 * discards the spacing the write path preserves.
 *
 * One formatter for three grammars, like the shared hover and semantic-token
 * providers: the rules key on `$type` over the one shared reflection, and all
 * three grammars use the same brace-and-indent shape.
 *
 * **Indent width comes from the request, not from this file.**
 * `AbstractFormatter` reads it off the `FormattingOptions` the client sent, so
 * hard-coding the serializers' three spaces here ignores what the editor asked
 * for. The two answer different questions and are expected to differ.
 */
export class OrderFlowFormatter extends AbstractFormatter {
   protected format(node: AstNode): void {
      if (isProcessModel(node) || isLayoutModel(node) || isEntity(node) || isValueType(node) || isEnumeration(node)) {
         this.formatBracedBlock(node);
      }

      // A task's effects and a gateway's branches are continuation lines rather
      // than a braced block — the grammar closes neither — so they indent
      // against their owner instead of against a brace pair.
      if (isTask(node)) {
         this.getNodeFormatter(node).properties('effects').prepend(Formatting.indent());
      }
      if (isGateway(node)) {
         this.getNodeFormatter(node).properties('branches').prepend(Formatting.indent());
      }

      // Top-level declarations sit at column zero. Without this they inherit the
      // enclosing indentation context and every declaration after the first
      // drifts one level right.
      if (isDomainModel(node)) {
         this.getNodeFormatter(node)
            .nodes(...node.declarations)
            .prepend(Formatting.noIndent());
      }

      // `node Pay at 40, 100 size 160, 60` is one line by design, so the only
      // rule is that the separators do not collect stray spaces.
      if (isDiagramNode(node)) {
         this.getNodeFormatter(node).keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
      }
   }

   /**
    * The shape every braced declaration in these grammars shares: members
    * indented one level, closing brace back on its own line.
    *
    * An EMPTY block is left alone. `Formatting.newLine()` on the closing brace
    * would turn the serializers' `{}` into a two-line block, so formatting a
    * file the serializer just wrote would change it — and the two would
    * disagree about a document neither had a reason to alter.
    */
   protected formatBracedBlock(node: AstNode): void {
      const formatter = this.getNodeFormatter(node);
      const bracesOpen = formatter.keyword('{');
      const bracesClose = formatter.keyword('}');
      bracesOpen.prepend(Formatting.oneSpace());
      if (bracesOpen.nodes[0]?.end === bracesClose.nodes[0]?.offset) {
         return;
      }
      formatter.interior(bracesOpen, bracesClose).prepend(Formatting.indent());
      bracesClose.prepend(Formatting.newLine());
   }
}
