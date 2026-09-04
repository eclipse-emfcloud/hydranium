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
import {
   type Declaration,
   type DomainModel,
   type Enumeration,
   type Field,
   type ProjectManifest,
   isDomainModel,
   isEntity,
   isEnumeration,
   isField,
   isProjectManifest,
   isValueType
} from './ast.js';

/**
 * Serializer for the `*.domain` language. Emits source that re-parses to an
 * equivalent AST, which is what makes `ModelService.update` / `save` write
 * files the language server can read back on the next build.
 *
 * Layout mirrors the grammar exactly:
 *
 * ```
 * project <name> [requires <id>, <id>]
 *
 * [public] entity|valuetype <name> {
 *    <field>: <type>[[]]
 * }
 * [public] enum <name> { <literal>, <literal> }
 * ```
 *
 * Dispatches per `$type` rather than through the base's generic property
 * table: the concrete syntax has node-specific layout (keyword prefix,
 * optional modifier, brace bodies) that a property walker cannot express.
 * Every serializer in this example does the same thing for the same reason,
 * which is the honest cost of a custom concrete syntax — the framework
 * cannot default a serializer because a serializer is always grammar-shaped.
 */
export class DomainSerializer extends AbstractSerializer<DomainModel> {
   /** 3-space indent matches the example's source-code style. */
   private static readonly INDENT_UNIT = '   ';

   override serializeAst(model: DomainModel): string {
      return this.serializeNode(model, 0);
   }

   protected override serializeNode(node: AstNode | Record<string, unknown>, indentationLevel: number, _isArrayElement = false): string {
      if (isDomainModel(node)) {
         return this.emitModel(node);
      }
      if (isEntity(node) || isValueType(node)) {
         return this.emitStructure(node.$type === 'Entity' ? 'entity' : 'valuetype', node, indentationLevel);
      }
      if (isEnumeration(node)) {
         return this.emitEnumeration(node, indentationLevel);
      }
      if (isField(node)) {
         return this.emitField(node, indentationLevel);
      }
      if (isProjectManifest(node)) {
         return this.emitManifest(node);
      }
      // Defensive — grammar evolution adds a top-level type we forgot here.
      throw new Error(`DomainSerializer: no emitter for $type ${(node as AstNode).$type}`);
   }

   /**
    * Not used — the `.domain` syntax emits its lists (declarations, fields,
    * literals) from the per-`$type` parent, so the generic dispatch never
    * reaches these. Throwing surfaces an accidental route through
    * `serializePropertyValue` instead of silently emitting JSON-ish text.
    */
   protected override serializeArray(): string {
      throw new Error('DomainSerializer: arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   /** Not used — same reasoning as {@link serializeArray}. */
   protected override serializeReferenceArray(): string {
      throw new Error('DomainSerializer: reference arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   private emitModel(model: DomainModel): string {
      const blocks: string[] = [];
      if (model.project) {
         blocks.push(this.emitManifest(model.project));
      }
      for (const declaration of model.declarations) {
         blocks.push(this.serializeNode(declaration, 0));
      }
      return blocks.join('\n\n');
   }

   private emitManifest(manifest: ProjectManifest): string {
      const requires = manifest.dependencies.length > 0 ? ` requires ${manifest.dependencies.join(', ')}` : '';
      return `project ${manifest.name}${requires}`;
   }

   private emitStructure(keyword: 'entity' | 'valuetype', declaration: Extract<Declaration, { fields: Field[] }>, level: number): string {
      const indent = this.indent(level);
      const header = `${indent}${this.visibilityPrefix(declaration)}${keyword} ${declaration.name}`;
      if (declaration.fields.length === 0) {
         return `${header} {}`;
      }
      const fields = declaration.fields.map(field => this.emitField(field, level + 1)).join('\n');
      return `${header} {\n${fields}\n${indent}}`;
   }

   private emitEnumeration(enumeration: Enumeration, level: number): string {
      const indent = this.indent(level);
      const header = `${indent}${this.visibilityPrefix(enumeration)}enum ${enumeration.name}`;
      if (enumeration.literals.length === 0) {
         return `${header} {}`;
      }
      return `${header} { ${enumeration.literals.map(literal => literal.name).join(', ')} }`;
   }

   private emitField(field: Field, level: number): string {
      // `Field.type` is always a cross-reference — primitives are stdlib
      // `valuetype` declarations rather than a keyword alternative — so there is
      // no non-reference branch. `serializeReferenceText` accepts both shapes: an
      // AST-mode Langium `Reference` and a transfer-mode plain string id.
      const type = this.serializeReferenceText(field.type.declared) ?? '';
      return `${this.indent(level)}${field.name}: ${type}${field.many ? '[]' : ''}`;
   }

   private visibilityPrefix(declaration: Declaration): string {
      return declaration.visibility === 'public' ? 'public ' : '';
   }

   private indent(level: number): string {
      return DomainSerializer.INDENT_UNIT.repeat(level);
   }
}
