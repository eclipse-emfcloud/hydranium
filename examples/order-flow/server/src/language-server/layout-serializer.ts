/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractSerializer } from '@hydranium/core';
import type { AstNode } from '@hydranium/langium';
import { type DiagramNode, type LayoutModel, isDiagramNode, isLayoutModel } from './ast.js';

/**
 * Serializer for the `*.layout` language.
 *
 * ```
 * layout <name> for <process> {
 *    node <flow node> at <x>, <y> size <width>, <height>
 * }
 * ```
 *
 * This is where the per-URI `Serializer` resolution stops being incidental
 * plumbing: a GLSP operation writes a `.layout` and a `.process` in one command,
 * so ONE user gesture routes through two different serializers picked by URI. A
 * single-grammar adopter never exercises that; a two-grammar one exercises it
 * only across separate saves.
 *
 * Like its siblings, this reads reference **text** rather than resolved targets,
 * so a layout file naming a flow node that no longer exists round-trips unchanged
 * instead of silently dropping the entry on save — the user gets a linking
 * diagnostic and their file back, which is the recoverable half of the
 * non-atomic multi-document write.
 */
export class LayoutSerializer extends AbstractSerializer<LayoutModel> {
   /** 3-space indent matches the example's source-code style. */
   private static readonly INDENT_UNIT = '   ';

   override serializeAst(model: LayoutModel): string {
      return this.serializeNode(model, 0);
   }

   protected override serializeNode(node: AstNode | Record<string, unknown>, indentationLevel: number, _isArrayElement = false): string {
      if (isLayoutModel(node)) {
         return this.emitLayout(node);
      }
      if (isDiagramNode(node)) {
         return this.emitDiagramNode(node, indentationLevel);
      }
      // Defensive — grammar evolution adds a top-level type we forgot here.
      throw new Error(`LayoutSerializer: no emitter for $type ${(node as AstNode).$type}`);
   }

   /** Not used — the sole list is emitted from the `LayoutModel` parent. */
   protected override serializeArray(): string {
      throw new Error('LayoutSerializer: arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   /** Not used — same reasoning as {@link serializeArray}. */
   protected override serializeReferenceArray(): string {
      throw new Error('LayoutSerializer: reference arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   private emitLayout(model: LayoutModel): string {
      const process = this.serializeReferenceText(model.process) ?? '';
      const header = `layout ${model.name} for ${process}`;
      if (model.nodes.length === 0) {
         // A layout file whose every entry was deleted stays a valid file rather
         // than becoming unparseable — the diagram is simply unpositioned.
         return `${header} {}`;
      }
      return `${header} {\n${model.nodes.map(node => this.emitDiagramNode(node, 1)).join('\n')}\n}`;
   }

   /**
    * `size` is omitted unless both dimensions are present, matching the
    * grammar's `('size' width ',' height)?` group — a node positioned but never
    * measured is a real state, produced by creating one from the canvas.
    */
   private emitDiagramNode(node: DiagramNode, level: number): string {
      const flowNode = this.serializeReferenceText(node.flowNode) ?? '';
      const bounds = `at ${this.emitNumber(node.x)}, ${this.emitNumber(node.y)}`;
      const size =
         node.width !== undefined && node.height !== undefined
            ? ` size ${this.emitNumber(node.width)}, ${this.emitNumber(node.height)}`
            : '';
      return `${this.indent(level)}node ${flowNode} ${bounds}${size}`;
   }

   /**
    * Rounded to two decimals. GLSP reports client-measured bounds as sub-pixel
    * floats, so persisting them raw turns every drag into a diff full of
    * `120.00000000000001` and makes the layout file churn on saves that changed
    * nothing visible.
    */
   private emitNumber(value: number): string {
      return String(Math.round(value * 100) / 100);
   }

   private indent(level: number): string {
      return LayoutSerializer.INDENT_UNIT.repeat(level);
   }
}
