/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   defineMessage,
   describeError,
   messageData,
   type LogThreshold,
   type MaybeObservableValue,
   ObservableValue,
   type Tracer,
   TransferDiagnostic
} from '@hydranium/protocol';
import {
   type AstNode,
   type AstNodeLocator,
   type AstReflection,
   DefaultDocumentValidator,
   type DiagnosticInfo,
   DocumentValidator,
   type LangiumDocument,
   type LangiumCoreServices,
   type ValidateSingleNodeOptions,
   type ValidationOptions,
   type ValidationSeverity
} from '@hydranium/langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
// A VALUE import, for `Diagnostic.getMessageString`: `message` is
// `string | MarkupContent` in LSP 3.17+, so upstream's own reader is what
// narrows it rather than a hand-rolled union check here.
import { Diagnostic } from 'vscode-languageserver-types';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { isSyntheticNode } from '../workspace/synthetic.js';
import { isVirtualUri } from '../workspace/virtual-document.js';

/**
 * Diagnostic read off a `LangiumDocument`: an LSP {@link Diagnostic} that MAY
 * carry the protocol-level `element` path and `property` name from
 * {@link TransferDiagnostic}.
 *
 * `element` is optional because a document's diagnostics do not all come from
 * this validator. {@link HydraniumDocumentValidator.toDiagnostic} always sets
 * one, but Langium pushes lexer and parser errors straight onto the document
 * without routing them through it, so a document that fails to parse carries
 * diagnostics with no path at all. Treat it as absent, not empty.
 *
 * Narrowing `LangiumDocument.diagnostics` to this type instead is unavailable:
 * declaration merging may add a member but not retype one, and augmenting the
 * LSP `Diagnostic` reaches only one of the two declaration files its package
 * ships, since the `exports` map splits `import` from `default` with no `types`
 * condition. Consumers therefore cast at the read, and the cast is sound only
 * because this field is optional.
 */
export interface TransferLspDiagnostic extends Diagnostic {
   element?: string;
   property?: string;
}

/**
 * A reference resolved to nothing.
 *
 * **The English is byte-identical to Langium's `DefaultLinker.createLinkingError`
 * sentence, and must stay so.** The identity is attached to a diagnostic Langium
 * already worded, so a divergence here would silently change the text every
 * adopter without a catalogue sees. {@link HydraniumDocumentValidator.processLinkingErrors}
 * attaches it only when the two match exactly, which is also what keeps an
 * adopter's own reworded linking error from being mislabelled as this one.
 *
 * It exists because this is the most-seen validation error in any language built
 * on the framework, and Langium puts its own code in `data.code` rather than on
 * `Diagnostic.code` — so without a framework identity every adopter wanting to
 * render it has to special-case Langium's shape.
 */
export const UNRESOLVED_REFERENCE = defineMessage(
   'hydranium/core/unresolved-reference',
   "Could not resolve reference to {referenceType} named '{refText}'."
);

/**
 * A character no token of the grammar can start with.
 *
 * **The English is byte-identical to CHEVROTAIN's
 * `defaultLexerErrorProvider.buildUnexpectedCharactersMessage`, and must stay
 * so** — one layer further out than {@link UNRESOLVED_REFERENCE}, whose sentence
 * is Langium's. Langium words neither: `processLexingErrors` copies
 * `lexerDiagnostic.message` through untouched, so the text an adopter sees today
 * is produced two dependencies down and is the only thing this identity may
 * claim to be. {@link HydraniumDocumentValidator.identifyLexingError} attaches
 * it only when the two match exactly, which is also what keeps a custom lexer's
 * own diagnostics — Langium admits any of them through `lexerReport` — from
 * being mislabelled as this one.
 *
 * It exists because a lexing error is the FIRST message a user of a new language
 * sees and the one an adopter cannot reach: every other diagnostic worth
 * translating either carries an identity already or is raised by adopter code,
 * while this one arrives with a Langium `data.code` naming a KIND and no
 * parameters at all — so a catalogue had nothing to key on and nothing to
 * interpolate.
 *
 * `skipped` rather than `length`, matching what the sentence says the number
 * means: chevrotain reports how many characters the lexer discarded to recover,
 * which for a single stray character is one and for a run of them is the run.
 */
export const LEXING_ERROR = defineMessage(
   'hydranium/core/lexing-error',
   'unexpected character: ->{character}<- at offset: {offset}, skipped {skipped} characters.'
);

/**
 * Langium's own `data.code` values for a diagnostic that came out of the lexer.
 *
 * All four severities, not just the error one: `lexerReport` admits warnings and
 * below, and a token builder that downgrades a stray character still produces
 * the same sentence. Gating on the error code alone would leave the identity off
 * a message that is word-for-word the one it names.
 */
const LEXING_CODES: ReadonlySet<unknown> = new Set([
   DocumentValidator.LexingError,
   DocumentValidator.LexingWarning,
   DocumentValidator.LexingInfo,
   DocumentValidator.LexingHint
]);

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
   protected readonly reflection: AstReflection;
   protected readonly logLevel: ObservableValue<LogThreshold>;
   protected readonly logAfterMs: ObservableValue<number>;
   protected readonly validateVirtualDocuments: ObservableValue<boolean>;
   protected readonly validateSyntheticNodes: ObservableValue<boolean>;

   constructor(services: LangiumCoreServices & { shared: { Tracer: Tracer } }, options: DocumentValidatorOptions = {}) {
      super(services);
      this.tracer = services.shared.Tracer.for(options.logName ?? 'DocumentValidator').trace('instantiated');
      this.astNodeLocator = services.workspace.AstNodeLocator;
      this.reflection = services.shared.AstReflection;
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
         return this.validateAndIdentify(document, options, cancelToken);
      }
      // `level` is narrowed to `LogLevel` past the early-return.
      return this.tracer
         .withUri(document.uri.toString())
         .time('validateDocument', () => this.validateAndIdentify(document, options, cancelToken), level, {
            logAfterMs: this.logAfterMs.value
         });
   }

   /**
    * Langium's validation pass, plus the framework identity on the lexing
    * diagnostics it produced.
    *
    * **Here rather than in an override of `processLexingErrors`, and the reason
    * is that the seam cannot see what the identity needs.** Langium hands that
    * method a `ParseResult`, which carries the AST and the error lists but not
    * the source text — and the offending CHARACTER is the parameter a
    * translation exists to interpolate. The document does carry it, and this is
    * the innermost point that still holds one. Reconstructing the character by
    * matching it out of the finished sentence was the alternative, and it
    * inverts the direction the rest of this file works in: every other identity
    * here is derived from structured fields and CHECKED against the prose.
    *
    * Inside the timing span rather than around it, so the line accounts for the
    * whole pass.
    */
   protected async validateAndIdentify(
      document: LangiumDocument,
      options?: ValidationOptions,
      cancelToken?: CancellationToken
   ): Promise<Diagnostic[]> {
      const diagnostics = await super.validateDocument(document, options, cancelToken);
      // Mapped in place over the array Langium built, rather than filtered and
      // re-concatenated: the publish order is the diagnostic order and a
      // reordering would move a squiggle's entry in the problems list.
      for (let index = 0; index < diagnostics.length; index++) {
         diagnostics[index] = this.identifyLexingError(document, diagnostics[index]);
      }
      return diagnostics;
   }

   /**
    * Add the {@link LEXING_ERROR} identity to one diagnostic, or return it
    * untouched when it is not the sentence that identity renders.
    *
    * The parameters come from the diagnostic's own RANGE, not from
    * `parseResult.lexerErrors`. Both hold the same numbers, and the range is the
    * one that needs no assumption about upstream: correlating the two lists
    * would depend on Langium appending one diagnostic per lexer error in order,
    * which is true today and is an internal of the method being wrapped.
    *
    * **The format-and-compare is the whole discriminator, and it validates the
    * reconstruction as well as the identity.** A range that did not round-trip
    * to the offset chevrotain reported would produce a different sentence and be
    * declined, so a wrong parameter set can never be attached to a right-looking
    * message.
    */
   protected identifyLexingError(document: LangiumDocument, diagnostic: Diagnostic): Diagnostic {
      const data = diagnostic.data as { code?: unknown } | undefined;
      if (!LEXING_CODES.has(data?.code)) {
         return diagnostic;
      }
      const text = document.textDocument;
      const offset = text.offsetAt(diagnostic.range.start);
      const params = {
         character: text.getText().charAt(offset),
         offset,
         skipped: text.offsetAt(diagnostic.range.end) - offset
      };
      if (Diagnostic.getMessageString(diagnostic) !== LEXING_ERROR.format(params)) {
         return diagnostic;
      }
      // Merged OVER Langium's data, so `data.code` survives for the readers that
      // switch on it — `stopAfterLexingErrors` is one, and the GLSP head's
      // read-only decision is another.
      return { ...diagnostic, code: LEXING_ERROR.code, data: { ...data, ...messageData(LEXING_ERROR, params) } };
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

   /**
    * Langium's linking-error pass, plus the framework identity on each
    * diagnostic it produced.
    *
    * Langium puts its own `linking-error` marker in `data.code` and leaves
    * `Diagnostic.code` unset, so nothing identifies the message on a surface
    * that drops `data` — which is every editor surface. This adds the framework
    * identity to both `code` and `data.hydranium` while LEAVING `data.code` in
    * place: `stopAfterLinkingErrors` and Langium's code-action dispatch both
    * read it.
    *
    * **The identity is attached only when the message is the one
    * {@link UNRESOLVED_REFERENCE} renders.** Two other sentences reach this
    * list: the linker's exception form, raised when resolution itself throws,
    * and whatever an adopter overriding `createLinkingError` chose. Labelling
    * either would make a catalogue render the wrong sentence — and for the
    * exception form it would discard the underlying cause. Comparing against
    * the locally rendered English is what discriminates; there is no structural
    * field that does.
    */
   protected override processLinkingErrors(document: LangiumDocument, diagnostics: Diagnostic[], options: ValidationOptions): void {
      const from = diagnostics.length;
      super.processLinkingErrors(document, diagnostics, options);
      for (let index = from; index < diagnostics.length; index++) {
         diagnostics[index] = this.identifyLinkingError(diagnostics[index]);
      }
   }

   /**
    * Add the {@link UNRESOLVED_REFERENCE} identity to one linking diagnostic,
    * or return it untouched when its message is not the sentence that identity
    * renders.
    *
    * `refText` comes from the `data` Langium populated; `referenceType` is not
    * in it, so it is recovered the same way `createLinkingError` produced it —
    * through the reflection, from the container type and property.
    */
   protected identifyLinkingError(diagnostic: Diagnostic): Diagnostic {
      const data = diagnostic.data as { code?: unknown; refText?: unknown; containerType?: unknown; property?: unknown } | undefined;
      if (typeof data?.refText !== 'string' || typeof data.containerType !== 'string' || typeof data.property !== 'string') {
         return diagnostic;
      }
      const referenceType = this.referenceTypeOf(data.containerType, data.property, data.refText);
      if (referenceType === undefined) {
         return diagnostic;
      }
      const params = { referenceType, refText: data.refText };
      if (diagnostic.message !== UNRESOLVED_REFERENCE.format(params)) {
         return diagnostic;
      }
      // Merged OVER Langium's data rather than replacing it, so `data.code`
      // survives for the readers that switch on it.
      return { ...diagnostic, code: UNRESOLVED_REFERENCE.code, data: { ...data, ...messageData(UNRESOLVED_REFERENCE, params) } };
   }

   /**
    * The declared target type of the reference this diagnostic came from, or
    * `undefined` when the reflection cannot name one.
    *
    * **The lookup can throw, and that is the reason this is a method rather
    * than an inline call.** `AbstractAstReflection.getReferenceType` raises on
    * an unknown container `$type` and on a property that is not a reference —
    * and the linking error whose type it cannot name is the one most likely to
    * reach here, because `DefaultLinker` catches its OWN failed lookup and
    * turns it into the exception-form message. Rethrowing would take
    * `validateDocument` with it, since Langium wraps `processLinkingErrors` in
    * no try: a diagnostic Langium degraded gracefully would become a failed
    * build. Declining is also the right answer on the merits — a reference
    * whose type cannot be named is not the message
    * {@link UNRESOLVED_REFERENCE} claims.
    */
   protected referenceTypeOf(containerType: string, property: string, refText: string): string | undefined {
      try {
         return this.reflection.getReferenceType({
            container: { $type: containerType } as AstNode,
            property,
            reference: { $refText: refText }
         } as Parameters<AstReflection['getReferenceType']>[0]);
      } catch (err: unknown) {
         this.tracer.debug(`cannot name the reference type for ${containerType}.${property}: ${describeError(err)}`);
         return undefined;
      }
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
