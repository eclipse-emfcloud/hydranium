/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LogThreshold, type MaybeObservableValue, ObservableValue, type Tracer, TransferDiagnostic } from '@hydranium/protocol';
import {
   type AstNode,
   type AstNodeLocator,
   DefaultDocumentValidator,
   type DiagnosticInfo,
   type LangiumDocument,
   type LangiumCoreServices,
   type ValidateSingleNodeOptions,
   type ValidationOptions,
   type ValidationSeverity
} from '@hydranium/langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import type { Diagnostic } from 'vscode-languageserver-types';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { isSyntheticNode } from '../workspace/synthetic.js';
import { isVirtualUri } from '../workspace/virtual-document.js';

/**
 * Diagnostic shape produced by {@link HydraniumDocumentValidator}: an LSP
 * {@link Diagnostic} extended with the protocol-level `element` path and
 * optional `property` name from {@link TransferDiagnostic}.
 */
export interface TransferLspDiagnostic extends Diagnostic {
   element: string;
   property?: string;
}

export interface DocumentValidatorOptions extends LogNameOptions {
   /**
    * Level at which the `validateDocument` timing line is emitted, or `'off'`
    * to disable the timing wrap entirely. Default: `'debug'`. Read per call, so
    * it accepts a {@link MaybeObservableValue} — pass a constant or bind it to a
    * user setting (via the `Settings` namespace) to retune live.
    */
   readonly logLevel?: MaybeObservableValue<LogThreshold>;
   /**
    * Suppress the timing line for validation runs shorter than this. Default:
    * `20`ms. Read per call; accepts a {@link MaybeObservableValue}.
    */
   readonly logAfterMs?: MaybeObservableValue<number>;
   /**
    * Validate documents under the virtual URI scheme (see `isVirtualUri`).
    * Default `false`: virtual documents (stdlib / library / built-in content)
    * are skipped, because a virtual URI cannot be opened, so a diagnostic on it
    * is un-actionable, and shipped library content is presumed correct. Set
    * `true` to validate built-in definitions. Read per call, so it accepts a
    * {@link MaybeObservableValue} — bind it to a user setting to toggle live.
    */
   readonly validateVirtualDocuments?: MaybeObservableValue<boolean>;
   /**
    * Validate nodes marked synthetic via `markSynthetic` (see `isSyntheticNode`).
    * Default `false`: synthetic nodes (stdlib content, projection mirrors) are
    * skipped, so a mirror never double-reports an error owned by its real
    * declaration. Set `true` to validate them normally. Read per call, so it
    * accepts a {@link MaybeObservableValue}.
    */
   readonly validateSyntheticNodes?: MaybeObservableValue<boolean>;
}

/**
 * Default validator behaviour for `@hydranium/core` consumers:
 *
 * - **Skip-validation hook** via the virtual {@link shouldSkipValidation}
 *   predicate, which adopters override to compose additional skip reasons.
 * - **Diagnostic mapping** to {@link TransferDiagnostic}-shaped
 *   {@link TransferLspDiagnostic}: every emitted diagnostic carries the AST
 *   node's path (built via Langium's `AstNodeLocator`) plus the optional
 *   offending property name.
 * - **Optional timing wrap** on `validateDocument`, on by default.
 */
export class HydraniumDocumentValidator extends DefaultDocumentValidator {
   protected readonly tracer: Tracer;
   protected readonly astNodeLocator: AstNodeLocator;
   protected readonly logLevel: ObservableValue<LogThreshold>;
   protected readonly logAfterMs: ObservableValue<number>;
   protected readonly validateVirtualDocuments: ObservableValue<boolean>;
   protected readonly validateSyntheticNodes: ObservableValue<boolean>;

   constructor(services: LangiumCoreServices & { shared: { Tracer: Tracer } }, options: DocumentValidatorOptions = {}) {
      super(services);
      this.tracer = services.shared.Tracer.for(options.logName ?? 'DocumentValidator').trace('instantiated');
      this.astNodeLocator = services.workspace.AstNodeLocator;
      this.logLevel = ObservableValue.from(options.logLevel ?? 'debug');
      this.logAfterMs = ObservableValue.from(options.logAfterMs ?? 20);
      this.validateVirtualDocuments = ObservableValue.from(options.validateVirtualDocuments ?? false);
      this.validateSyntheticNodes = ObservableValue.from(options.validateSyntheticNodes ?? false);
   }

   override validateDocument(
      document: LangiumDocument,
      options?: ValidationOptions,
      cancelToken?: CancellationToken
   ): Promise<Diagnostic[]> {
      // Skip whole virtual documents (stdlib / library / built-in) unless opted
      // in — a virtual URI cannot be opened, so diagnostics on it are
      // un-actionable. Decided per document (not per node) so the walk is
      // avoided entirely; the per-node `$synthetic` skip is separate.
      if (isVirtualUri(document.uri) && !this.validateVirtualDocuments.value) {
         this.tracer.withUri(document.uri.toString()).debug('skipping validation (virtual document)');
         return Promise.resolve([]);
      }
      const level = this.logLevel.value;
      if (level === 'off') {
         return super.validateDocument(document, options, cancelToken);
      }
      // `level` is narrowed to `LogLevel` past the early-return.
      return this.tracer
         .withUri(document.uri.toString())
         .time('validateDocument', () => super.validateDocument(document, options, cancelToken), level, {
            logAfterMs: this.logAfterMs.value
         });
   }

   /**
    * Skip validation for a node **and its children** when
    * {@link shouldSkipValidation} returns true.
    */
   protected override validateSingleNodeOptions(node: AstNode, options: ValidationOptions): ValidateSingleNodeOptions {
      if (this.shouldSkipValidation(node)) {
         return { validateNode: false, validateChildren: false };
      }
      return super.validateSingleNodeOptions(node, options);
   }

   /**
    * True when validation should skip `node` and its children. Default: the
    * node is marked synthetic ({@link isSyntheticNode}) and
    * {@link DocumentValidatorOptions.validateSyntheticNodes} has not opted back
    * in — so the option and the predicate are one decision, not two. Adopters
    * override to compose additional skip reasons with
    * `super.shouldSkipValidation(node) || ...`.
    */
   protected shouldSkipValidation(node: AstNode): boolean {
      return !this.validateSyntheticNodes.value && isSyntheticNode(node);
   }

   protected override toDiagnostic<N extends AstNode>(
      severity: ValidationSeverity,
      message: string,
      info: DiagnosticInfo<N, string>
   ): TransferLspDiagnostic {
      const base = super.toDiagnostic(severity, message, info);
      const node = info.node;
      if (!node) {
         this.tracer.warn('Cannot create diagnostic element path: DiagnosticInfo has no node.');
         return { ...base, property: info.property, element: '' };
      }
      const elementPath = this.buildElementPath(node, info);
      return { ...base, property: info.property, element: elementPath };
   }

   /**
    * Construct the `element` path for a diagnostic. Falls back through:
    * - the node's own AST path, then
    * - the parent's AST path (for nodes Langium can't locate directly, e.g.
    *   references or transient nodes).
    *
    * When the path doesn't include the array index (some reference-array
    * cases) but `info.index` is provided, the index is appended explicitly
    * — keeping element paths stable and consistent with how the client
    * expects collection-item paths to be formed.
    */
   protected buildElementPath<N extends AstNode>(node: N, info: DiagnosticInfo<N, string>): string {
      const directPath = this.astNodeLocator.getAstNodePath(node);
      const containerPath = directPath ? undefined : this.astNodeLocator.getAstNodePath(node.$container ?? ({ $type: 'Dummy' } as AstNode));
      const nodePath = directPath || containerPath;
      if (!nodePath) {
         this.tracer.warn('Cannot create diagnostic element path: Unable to determine AST node path.');
         return '';
      }
      if (info.index === undefined || nodePath.endsWith(`${TransferDiagnostic.ELEMENT_INDEX_SEPARATOR}${info.index}`)) {
         return nodePath;
      }
      return info.property
         ? `${nodePath}${TransferDiagnostic.ELEMENT_SEGMENT_SEPARATOR}${info.property}${TransferDiagnostic.ELEMENT_INDEX_SEPARATOR}${info.index}`
         : `${nodePath}${TransferDiagnostic.ELEMENT_INDEX_SEPARATOR}${info.index}`;
   }
}
