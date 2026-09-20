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
   interpolate,
   type MessageDefinition,
   type MessageParams,
   messageData,
   type ParamsArg,
   type ParamsOf,
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
   type Lexer,
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
 * The AST-layer diagnostic: what the build left on `LangiumDocument`, and what
 * an `AstDocument` carries. An LSP {@link Diagnostic} that MAY also carry the
 * `element` path and `property` name from {@link TransferDiagnostic}.
 *
 * **Not interchangeable with {@link TransferDiagnostic}, which is the other end
 * of the same conversion.** They disagree on field types as well as on which
 * fields exist — `severity` is LSP's numeric enum here and a string union there
 * — so a slot typed with the wrong one still accepts the value and then reads
 * `undefined`, or compares equal to nothing.
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
export interface AstDiagnostic extends Diagnostic {
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
export const UNEXPECTED_CHARACTER = defineMessage(
   'hydranium/core/unexpected-character',
   'unexpected character: ->{character}<- at offset: {offset}, skipped {skipped} characters.'
);

/**
 * A token the grammar does not admit at this position.
 *
 * **The English is byte-identical to Langium's
 * `LangiumParserErrorMessageProvider.buildMismatchTokenMessage`, and must stay
 * so**, on the same rule as {@link UNRESOLVED_REFERENCE}.
 *
 * `expected` is a token type name, which is grammar vocabulary rather than
 * translatable text — only the frame around it is. Promoting it into the code
 * instead would make the catalogue as large as the grammar.
 */
export const UNEXPECTED_TOKEN = defineMessage(
   'hydranium/core/unexpected-token',
   "Expecting token of type '{expected}' but found `{found}`."
);

/**
 * Input left over once the entry rule had matched.
 *
 * **The English is byte-identical to Langium's
 * `LangiumParserErrorMessageProvider.buildNotAllInputParsedMessage`, and must
 * stay so.**
 */
export const TRAILING_INPUT = defineMessage('hydranium/core/trailing-input', 'Expecting end of file but found `{found}`.');

/**
 * A mode-popping token reached with nothing on the lexer's mode stack.
 *
 * **The English is byte-identical to CHEVROTAIN's
 * `defaultLexerErrorProvider.buildUnableToPopLexerModeMessage`, and must stay
 * so**, the closing clause running on without punctuation exactly as upstream
 * writes it.
 *
 * Reachable only from a multi-mode lexer, which a grammar opts into through a
 * custom token builder.
 */
export const UNPOPPABLE_LEXER_MODE = defineMessage(
   'hydranium/core/unpoppable-lexer-mode',
   'Unable to pop Lexer Mode after encountering Token ->{image}<- The Mode Stack is empty'
);

/**
 * A dedent that lines up with no enclosing indentation level.
 *
 * **The English is byte-identical to LANGIUM's `IndentationAwareTokenBuilder`,
 * and must stay so** — the one lexing sentence Langium words itself rather than
 * relaying from chevrotain, which is why it renders through no
 * `ILexerErrorMessageProvider` and an adopter cannot reach it by replacing one.
 *
 * `stack` is the indentation stack as the template literal upstream stringifies
 * it, comma-joined: structure would have to survive {@link MessageParams}, which
 * holds scalars, and a translation has nothing to say about the numbers anyway.
 */
export const INVALID_DEDENT = defineMessage(
   'hydranium/core/invalid-dedent',
   'Invalid dedent level {level} at offset: {offset}. Current indentation stack: {stack}'
);

/**
 * A position where none of a rule's alternatives can start.
 *
 * **The English is byte-identical to CHEVROTAIN's
 * `defaultParserErrorProvider.buildNoViableAltMessage`, and must stay so** —
 * one layer further out than {@link UNEXPECTED_TOKEN}, because Langium overrides
 * only two of the four parser sentences and passes this one straight through.
 *
 * `sequences` is the token-sequence list chevrotain generated, carried whole
 * rather than as structure: {@link MessageParams} holds scalars, and the list is
 * token names in any case, so only the frame around it is translatable.
 */
export const NO_VIABLE_ALTERNATIVE = defineMessage(
   'hydranium/core/no-viable-alternative',
   "Expecting: one of these possible Token sequences:\n{sequences}\nbut found: '{found}'"
);

/**
 * A repetition that had to match at least once and matched nothing.
 *
 * **The English is byte-identical to CHEVROTAIN's
 * `defaultParserErrorProvider.buildEarlyExitMessage`, and must stay so**,
 * including the doubled colon after `sequences::`, which is upstream's and not a
 * typo to repair here — a divergence would silently stop the identity attaching.
 *
 * Named for the empty repetition rather than for chevrotain's `EarlyExit`, which
 * describes its own control flow rather than the reader's problem.
 */
export const MISSING_ITERATION = defineMessage(
   'hydranium/core/missing-iteration',
   "Expecting: expecting at least one iteration which starts with one of these possible Token sequences::\n  <{sequences}>\nbut found: '{found}'"
);

/**
 * The two sentences whose only free parameter is a generated list, in the order
 * {@link HydraniumDocumentValidator.identifyParsingError} tries them. Order is
 * free: their frames share a prefix but diverge before the list begins, so at
 * most one can match.
 */
const SEQUENCE_LISTING_MESSAGES = [NO_VIABLE_ALTERNATIVE, MISSING_ITERATION];

/**
 * Splits a template into alternating frame and placeholder NAME, for
 * {@link HydraniumDocumentValidator.sliceFramed}. The capturing group is what
 * keeps the names in the result rather than discarding them.
 */
const PLACEHOLDER_CAPTURE = /\{([^}]+)\}/;

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
 *   {@link AstDiagnostic}: every emitted diagnostic carries the AST
 *   node's path (built via Langium's `AstNodeLocator`) plus the optional
 *   offending property name.
 * - **Optional timing wrap** on `validateDocument`, on by default.
 */
export class HydraniumDocumentValidator extends DefaultDocumentValidator {
   protected readonly tracer: Tracer;
   protected readonly astNodeLocator: AstNodeLocator;
   protected readonly reflection: AstReflection;
   protected readonly lexer: Lexer;
   /**
    * {@link tokenTypeNames}' answer. Nothing invalidates it: the vocabulary
    * comes from the grammar, which is fixed once the DI tree is composed.
    */
   protected expectedNames?: readonly string[];
   protected readonly logLevel: ObservableValue<LogThreshold>;
   protected readonly logAfterMs: ObservableValue<number>;
   protected readonly validateVirtualDocuments: ObservableValue<boolean>;
   protected readonly validateSyntheticNodes: ObservableValue<boolean>;

   constructor(services: LangiumCoreServices & { shared: { Tracer: Tracer } }, options: DocumentValidatorOptions = {}) {
      super(services);
      this.tracer = services.shared.Tracer.for(options.logName ?? 'DocumentValidator').trace('instantiated');
      this.astNodeLocator = services.workspace.AstNodeLocator;
      this.reflection = services.shared.AstReflection;
      this.lexer = services.parser.Lexer;
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
    * Langium's validation pass, plus the framework identity on the lexing and
    * parsing diagnostics it produced.
    *
    * **Here rather than in an override of `processLexingErrors` /
    * `processParsingErrors`, and the reason is that neither seam can see what
    * the identity needs.** Langium hands them a `ParseResult`, which carries the
    * AST and the error lists but not the source text — and the offending
    * CHARACTER, or the offending TOKEN, is the parameter a translation exists to
    * interpolate. The document does carry it, and this is the innermost point
    * that still holds one.
    *
    * Correlating the finished diagnostics back to the `ParseResult`'s error
    * lists positionally is the alternative, and it is unsound for the parsing
    * half: `processParsingErrors` DROPS an error whose token offsets are `NaN`
    * and whose exception carries no `previousToken`, so the two lists differ in
    * length exactly when recovery has been at work.
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
      // Each pass guards on its own `data.code`, so at most one can claim a
      // given diagnostic and the order between them carries no meaning.
      for (let index = 0; index < diagnostics.length; index++) {
         diagnostics[index] = this.identifyLexingError(document, diagnostics[index]);
         diagnostics[index] = this.identifyParsingError(document, diagnostics[index]);
      }
      return diagnostics;
   }

   /**
    * Add whichever lexing identity renders `diagnostic`'s sentence, or return it
    * untouched when none of them does — a custom lexer's own report, which
    * Langium admits through `lexerReport`, being the case that reaches the end.
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
      const message = Diagnostic.getMessageString(diagnostic);
      const offset = text.offsetAt(diagnostic.range.start);
      const stray = {
         character: text.getText().charAt(offset),
         offset,
         skipped: text.offsetAt(diagnostic.range.end) - offset
      };
      if (message === UNEXPECTED_CHARACTER.format(stray)) {
         return this.identified(diagnostic, UNEXPECTED_CHARACTER, stray);
      }
      // The mode-pop error's range spans the offending token exactly, upstream
      // reporting its `startOffset` with the image's own length.
      const image = text.getText(diagnostic.range);
      if (message === UNPOPPABLE_LEXER_MODE.format({ image })) {
         return this.identified(diagnostic, UNPOPPABLE_LEXER_MODE, { image });
      }
      // `level` and `stack` are lexer state that reaches no field here, so they
      // are sliced; `offset` is given, which is what anchors the slice.
      const dedent = this.sliceFramed(message, INVALID_DEDENT, { offset });
      return dedent === undefined ? diagnostic : this.identified(diagnostic, INVALID_DEDENT, dedent);
   }

   /**
    * Add whichever parser identity renders `diagnostic`'s sentence, or return it
    * untouched when none of them does — an adopter that replaced the parser
    * error-message provider being the case that reaches the last branch.
    *
    * `found` comes from the diagnostic's own RANGE, for the same reason
    * {@link identifyLexingError} reads its parameters there. A token whose
    * offsets chevrotain could not report collapses to a zero-width range, which
    * yields the empty string the sentence already renders for it.
    *
    * **`expected` is recovered by SEARCHING the vocabulary, because nothing
    * carries it.** Chevrotain hands the expected token type to the message
    * provider and keeps it on neither the exception nor the diagnostic, so the
    * only structured source left is the grammar's own vocabulary: every token
    * type is offered to the same `format` the identity renders with, and the one
    * that reproduces the message supplies the parameter. Matching it out of the
    * prose instead would derive a parameter from a sentence that a Langium
    * reword can change without warning. Two distinct names cannot render one
    * sentence, so the match is unique where it exists.
    */
   protected identifyParsingError(document: LangiumDocument, diagnostic: Diagnostic): Diagnostic {
      const data = diagnostic.data as { code?: unknown } | undefined;
      if (data?.code !== DocumentValidator.ParsingError) {
         return diagnostic;
      }
      const message = Diagnostic.getMessageString(diagnostic);
      const found = document.textDocument.getText(diagnostic.range);
      if (message === TRAILING_INPUT.format({ found })) {
         return this.identified(diagnostic, TRAILING_INPUT, { found });
      }
      const expected = this.tokenTypeNames().find(name => UNEXPECTED_TOKEN.format({ expected: name, found }) === message);
      if (expected !== undefined) {
         return this.identified(diagnostic, UNEXPECTED_TOKEN, { expected, found });
      }
      for (const definition of SEQUENCE_LISTING_MESSAGES) {
         const params = this.sliceFramed(message, definition, { found });
         if (params !== undefined) {
            return this.identified(diagnostic, definition, params);
         }
      }
      return diagnostic;
   }

   /** `diagnostic` carrying `definition`'s identity, over whatever `data` it already had. */
   protected identified<S extends string>(diagnostic: Diagnostic, definition: MessageDefinition<S>, ...params: ParamsArg<S>): Diagnostic {
      // Merged OVER the existing data, so Langium's `code` survives for the
      // readers that switch on it — `stopAfterParsingErrors` is one, and the
      // GLSP head's read-only decision is another.
      const data = diagnostic.data as object | undefined;
      return { ...diagnostic, code: definition.code, data: { ...data, ...messageData(definition, ...params) } };
   }

   /**
    * `definition`'s parameters as they appear in `message`, taking the ones in
    * `known` as given, or `undefined` when `message` is not that sentence.
    *
    * **The only parameters in this file taken OUT of the prose rather than
    * derived and checked against it, and the bound on that is what `known`
    * is for.** A generated token-sequence list, a lexer's indentation stack: for
    * these there is no finite candidate set to offer to `format` the way a token
    * type name can be, and no structured field carries them. What keeps the read
    * honest is that everything else in the sentence is either a fixed literal or
    * a parameter the caller derived independently, so the frame either matches
    * exactly or the sentence is declined.
    *
    * **The trailing format-and-compare is load-bearing once more than one
    * parameter is unknown.** Each is captured up to the NEXT fixed separator, so
    * a separator that also occurs inside a value would cut early — re-rendering
    * catches that, where for a single unknown between two affixes it could not
    * fail. Two adjacent placeholders are declined outright: nothing marks the
    * boundary, so no capture is recoverable.
    *
    * The frame is split off the declaration's own `text`, so it cannot drift
    * from the sentence `format` renders.
    */
   protected sliceFramed<S extends string>(
      message: string,
      definition: MessageDefinition<S>,
      known: MessageParams
   ): ParamsOf<S> | undefined {
      // `split` with a capturing group interleaves literals and placeholder
      // names, so even indices are frame and odd ones are parameters.
      const parts = definition.text.split(PLACEHOLDER_CAPTURE);
      const params: Record<string, string | number> = { ...known };
      let cursor = 0;
      for (let index = 0; index < parts.length; index += 2) {
         const literal = parts[index];
         if (!message.startsWith(literal, cursor)) {
            return undefined;
         }
         cursor += literal.length;
         const name = parts[index + 1];
         if (name === undefined) {
            break;
         }
         const given = params[name];
         if (given !== undefined) {
            const rendered = String(given);
            if (!message.startsWith(rendered, cursor)) {
               return undefined;
            }
            cursor += rendered.length;
            continue;
         }
         const separator = parts[index + 2];
         const trailing = parts[index + 3] === undefined;
         if (separator === '' && !trailing) {
            return undefined;
         }
         const at = trailing && separator === '' ? message.length : message.indexOf(separator, cursor);
         if (at < cursor) {
            return undefined;
         }
         params[name] = message.slice(cursor, at);
         cursor = at;
      }
      if (cursor !== message.length || interpolate(definition.text, params) !== message) {
         return undefined;
      }
      // Narrowing only: every placeholder the template names was either given or
      // captured above, which is precisely what `ParamsOf` requires.
      return params as ParamsOf<S>;
   }

   /**
    * Every token type name the grammar declares, as
    * {@link identifyParsingError} candidates.
    *
    * Read off the lexer, whose `definition` the `Lexer` INTERFACE declares —
    * the parser holds the same vocabulary only behind Langium's default class,
    * where an adopter's replacement need not keep it. A token type the parser
    * expects but the lexer does not declare yields no match, which declines the
    * identity rather than attaching a wrong one.
    */
   protected tokenTypeNames(): readonly string[] {
      this.expectedNames ??= Object.keys(this.lexer.definition);
      return this.expectedNames;
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
   ): AstDiagnostic {
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
