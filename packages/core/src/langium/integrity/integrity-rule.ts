/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Logger, type MaybePromise } from '@hydranium/protocol';
import { type AstNode, DocumentState, type LangiumDocument } from '@hydranium/langium';
import { type RegistryItem } from '../../util/registry.js';

/**
 * Integrity rules run during a build phase and may mutate the AST. Allowed
 * phases are `Parsed` (before linking — a rule that touches only the parsed
 * shape) and `Linked` (after cross-references are resolved — a rule that
 * needs reference targets to exist).
 */
export type IntegrityPhase = DocumentState.Parsed | DocumentState.Linked;

export namespace IntegrityPhase {
   export const Parsed: IntegrityPhase = DocumentState.Parsed;
   export const Linked: IntegrityPhase = DocumentState.Linked;

   /**
    * The canonical set of phases at which integrity rules may run, in build
    * order. Single source of truth: `IntegrityService.register` validates
    * against it, and the framework's `BuildPipelineIntegration` registers one
    * integrity pass per entry. A function (not a const) so it reads as an
    * operation, distinct in kind from the `Parsed` / `Linked` phase-value
    * constants — `IntegrityPhase.all` would look like a third phase. Returns a
    * fresh array so callers cannot mutate the canonical set.
    */
   export function all(): readonly IntegrityPhase[] {
      return [Parsed, Linked];
   }

   export function toString(phase: DocumentState): string {
      switch (phase) {
         case DocumentState.Parsed:
            return 'Parsed';
         case DocumentState.Linked:
            return 'Linked';
         default:
            return `Unknown(${phase})`;
      }
   }
}

/**
 * Controls how integrity corrections are persisted for *closed* files. The
 * mode does not reach open files: their corrected text is delivered by the
 * model service's settled-state sync, whatever the mode says.
 *
 * - `silent`: write to disk immediately; no editor involvement.
 * - `editor`: open the file dirty via `applyEdit`. If the user closes without
 *    saving, the correction is suppressed until the file changes or the
 *    workspace reloads.
 */
export type IntegritySyncMode = 'silent' | 'editor';

/**
 * A single integrity rule that enforces a constraint on AST nodes of a given type
 * at a specific build phase.
 *
 * Extends {@link RegistryItem}: {@link RegistryItem.priority} orders rules
 * WITHIN one phase, never across phases, because each phase has its own
 * bucket. Lower runs first; ties break by registration order.
 */
export interface IntegrityRule<T extends AstNode = AstNode> extends RegistryItem {
   /** Which AST node type this rule applies to. */
   readonly nodeType: string;
   /** At which document state this rule should run. Be aware that extension properties may not be available in all phases. */
   readonly phase: IntegrityPhase;
   /**
    * Apply the rule. Returns `true` if the AST was mutated.
    *
    * Mirrors Langium's `ValidationCheck` shape (`MaybePromise<void>`) so a
    * rule that must consult an external system can return a promise without
    * forcing every sync rule to pay a microtask tick per node. The
    * framework's per-node dispatch uses `isPromiseLike` to keep sync
    * rules on the synchronous fast path; async rules are awaited normally.
    */
   enforce(node: T, document: LangiumDocument, logger: Logger): MaybePromise<boolean>;
}

/**
 * The author id an integrity correction would carry if integrity tagged
 * authorship. **It does not.** A correction is an internal build step riding a
 * user's own build, so tagging it would overwrite the last human author in the
 * version history with a synthetic one; `getAuthor` reports `undefined` for an
 * integrity-only mutation instead, which is the honest answer. None of the
 * three delivery paths — settled-state sync for open files, the disk write in
 * `silent` mode, staged pending content in `editor` mode — sets an author.
 *
 * Exported so a consumer can assert that a correction is NOT attributed to it,
 * which is what catches a regression that starts tagging authorship again.
 */
export const INTEGRITY_CLIENT_ID = 'integrity';
