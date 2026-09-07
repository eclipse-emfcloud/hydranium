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
   type Branch,
   type Effect,
   type Gateway,
   type ProcessModel,
   type Task,
   type Transition,
   isBranch,
   isGateway,
   isProcessModel,
   isRead,
   isTask,
   isTransition,
   isWrite
} from './ast.js';

/**
 * Serializer for the `*.process` language.
 *
 * ```
 * process <name> for <entity> {
 *    task <name>
 *       writes <entity>.<field> = <literal>
 *       reads <entity>.<field>
 *    gateway <name>
 *       <label> -> <target>
 *    transition <source> -> <target>
 * }
 * ```
 *
 * Layout is NOT here — it lives in a `*.layout` file with its own
 * `LayoutSerializer`. See `layout.langium` for what the separate file buys and
 * what it costs.
 *
 * Effects are emitted one per line even though the grammar also accepts
 * them inline after the task name, so output stays stable as a task grows
 * a second effect.
 *
 * The three-part effect is written back from `Write.entity` / `.field` /
 * `.literal` independently: the serializer reads the reference **text**
 * rather than the resolved target, so a `.process` file with a broken
 * effect round-trips unchanged instead of losing the user's typo on save.
 */
export class ProcessSerializer extends AbstractSerializer<ProcessModel> {
   /** 3-space indent matches the example's source-code style. */
   private static readonly INDENT_UNIT = '   ';

   override serializeAst(model: ProcessModel): string {
      return this.serializeNode(model, 0);
   }

   protected override serializeNode(node: AstNode | Record<string, unknown>, indentationLevel: number, _isArrayElement = false): string {
      if (isProcessModel(node)) {
         return this.emitProcess(node);
      }
      if (isTask(node)) {
         return this.emitTask(node, indentationLevel);
      }
      if (isGateway(node)) {
         return this.emitGateway(node, indentationLevel);
      }
      if (isTransition(node)) {
         return this.emitTransition(node, indentationLevel);
      }
      if (isBranch(node)) {
         return this.emitBranch(node, indentationLevel);
      }
      if (isWrite(node) || isRead(node)) {
         return this.emitEffect(node, indentationLevel);
      }
      // Defensive — grammar evolution adds a top-level type we forgot here.
      throw new Error(`ProcessSerializer: no emitter for $type ${(node as AstNode).$type}`);
   }

   /**
    * Not used — the `.process` syntax emits its lists (flow nodes,
    * transitions, effects, branches) from the per-`$type` parent, so the
    * generic dispatch never reaches these.
    */
   protected override serializeArray(): string {
      throw new Error('ProcessSerializer: arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   /** Not used — same reasoning as {@link serializeArray}. */
   protected override serializeReferenceArray(): string {
      throw new Error('ProcessSerializer: reference arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   private emitProcess(model: ProcessModel): string {
      const body = [
         ...model.nodes.map(node => this.serializeNode(node, 1)),
         ...model.transitions.map(transition => this.emitTransition(transition, 1))
      ];
      const subject = this.serializeReferenceText(model.subject) ?? '';
      const header = `process ${model.name} for ${subject}`;
      return body.length === 0 ? `${header} {}` : `${header} {\n${body.join('\n')}\n}`;
   }

   private emitTask(task: Task, level: number): string {
      const header = `${this.indent(level)}task ${task.name}`;
      if (task.effects.length === 0) {
         return header;
      }
      return [header, ...task.effects.map(effect => this.emitEffect(effect, level + 1))].join('\n');
   }

   private emitGateway(gateway: Gateway, level: number): string {
      const header = `${this.indent(level)}gateway ${gateway.name}`;
      if (gateway.branches.length === 0) {
         return header;
      }
      return [header, ...gateway.branches.map(branch => this.emitBranch(branch, level + 1))].join('\n');
   }

   private emitEffect(effect: Effect, level: number): string {
      const target = `${this.serializeReferenceText(effect.entity) ?? ''}.${this.serializeReferenceText(effect.field) ?? ''}`;
      if (isWrite(effect)) {
         return `${this.indent(level)}writes ${target} = ${this.serializeReferenceText(effect.literal) ?? ''}`;
      }
      return `${this.indent(level)}reads ${target}`;
   }

   private emitBranch(branch: Branch, level: number): string {
      return `${this.indent(level)}${branch.label} -> ${this.serializeReferenceText(branch.target) ?? ''}`;
   }

   private emitTransition(transition: Transition, level: number): string {
      const source = this.serializeReferenceText(transition.source) ?? '';
      const target = this.serializeReferenceText(transition.target) ?? '';
      return `${this.indent(level)}transition ${source} -> ${target}`;
   }

   private indent(level: number): string {
      return ProcessSerializer.INDENT_UNIT.repeat(level);
   }
}
