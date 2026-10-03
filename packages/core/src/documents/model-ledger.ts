/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode } from '@hydranium/langium';
import { asModelVersion, type ModelVersion, UNRECORDED_VERSION } from '@hydranium/protocol';

/** What {@link ModelLedger} holds for one root. */
export interface ModelRecord {
   readonly version: ModelVersion;
   /** For a root whose CST no longer is the text it describes: changed in place, or shed. */
   readonly text?: string;
}

/**
 * The version of the text each root was parsed from, and that text where the
 * root's CST does not hold it. Stores what it is told; the rest of the
 * framework relies on these:
 *
 * - every workspace root is recorded through `VersionSyncService.modelProduced` when produced;
 * - a version is recorded only for text the store held at that version, else `STALE_VERSION`;
 * - the builder's placeholder for a file it has not parsed carries no version;
 * - re-recording a root without text keeps the text recorded before.
 */
export interface ModelLedger {
   record(root: AstNode, version: number, text?: string): void;
   /** `UNRECORDED_VERSION`, which every write conflicts with, for a root nothing recorded. */
   versionOf(root: AstNode): ModelVersion;
   /** The recorded text, else the root's CST text; `undefined` for a root with neither. */
   textOf(root: AstNode): string | undefined;
   /** Mark `root`, registered before any parse, as no parse of any text, dropping its record. */
   markPlaceholder(root: AstNode): void;
   /** Keyed on the root, not its state: a rebuilt document is reset below `Parsed` but keeps its root. */
   isPlaceholder(root: AstNode): boolean;
}

export class DefaultModelLedger implements ModelLedger {
   protected readonly records = new WeakMap<AstNode, ModelRecord>();
   protected readonly placeholders = new WeakSet<AstNode>();

   record(root: AstNode, version: number, text?: string): void {
      this.records.set(root, { version: asModelVersion(version), text: text ?? this.records.get(root)?.text });
   }

   versionOf(root: AstNode): ModelVersion {
      return this.records.get(root)?.version ?? UNRECORDED_VERSION;
   }

   textOf(root: AstNode): string | undefined {
      return this.records.get(root)?.text ?? root.$cstNode?.root.fullText;
   }

   markPlaceholder(root: AstNode): void {
      this.placeholders.add(root);
      this.records.delete(root);
   }

   isPlaceholder(root: AstNode): boolean {
      return this.placeholders.has(root);
   }
}
