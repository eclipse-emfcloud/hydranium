/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultTracer, Disposable, type LogThreshold, type Logger, type Tracer, TransferDiagnostic } from '@hydranium/protocol';
import {
   type AstNode,
   type DiagnosticInfo,
   type LangiumCoreServices,
   type LangiumDocument,
   type ValidationSeverity
} from '@hydranium/langium';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
   HydraniumDocumentValidator,
   LEXING_ERROR,
   UNRESOLVED_REFERENCE,
   type DocumentValidatorOptions
} from '../../../src/langium/validation/document-validator.js';
import { makeFakeAstNode, makeFakeDocument, makeNoopTracer } from '../../../src/testing/index.js';

function makeLogger(): Tracer {
   return makeNoopTracer();
}

interface PathProvider {
   getAstNodePath(node: AstNode): string;
}

function makeStubServices(
   astNodeLocator: PathProvider,
   logger: Logger,
   // Overridable because `processLinkingErrors` recovers the reference type
   // through it, and one of its arms is the lookup RAISING.
   getReferenceType: () => string = () => 'Fake'
): LangiumCoreServices & { shared: { Tracer: Tracer } } {
   const documentBuilderStub = {
      onUpdate: () => Disposable.EMPTY,
      onBuildPhase: () => Disposable.EMPTY
   };
   return {
      shared: {
         // The stub carries the full timing surface, so it doubles as the Tracer.
         Tracer: logger,
         workspace: { DocumentBuilder: documentBuilderStub },
         profilers: { LangiumProfiler: undefined },
         AstReflection: { getReferenceType, isSubtype: () => true }
      },
      workspace: { AstNodeLocator: astNodeLocator },
      // `checksBefore`/`checksAfter` are iterated by Langium's DefaultDocumentValidator;
      // the stub must expose them as empty arrays or the for-of throws
      // "checksBefore is not iterable" (caught + logged by Langium as a validation error).
      validation: { ValidationRegistry: { getChecks: () => [], checksBefore: [], checksAfter: [] } },
      LanguageMetaData: { languageId: 'test' }
   } as unknown as LangiumCoreServices & { shared: { Tracer: Tracer } };
}

function diagnosticInfo<N extends AstNode>(
   node: N | undefined,
   overrides: Partial<DiagnosticInfo<N, string>> = {}
): DiagnosticInfo<N, string> {
   return {
      node: node!,
      range: Range.create(0, 0, 0, 0),
      ...overrides
   } as DiagnosticInfo<N, string>;
}

class TestValidator extends HydraniumDocumentValidator {
   constructor(
      pathProvider: PathProvider,
      logger: Logger,
      private readonly skipPredicate?: (node: AstNode) => boolean,
      options: DocumentValidatorOptions = {}
   ) {
      super(makeStubServices(pathProvider, logger), options);
   }

   protected override shouldSkipValidation(node: AstNode): boolean {
      if (this.skipPredicate) {
         return this.skipPredicate(node);
      }
      return super.shouldSkipValidation(node);
   }

   public callValidateOptions(
      node: AstNode,
      options = {} as Parameters<TestValidator['validateSingleNodeOptions']>[1]
   ): ReturnType<TestValidator['validateSingleNodeOptions']> {
      return this.validateSingleNodeOptions(node, options);
   }

   public callToDiagnostic(
      severity: ValidationSeverity,
      message: string,
      info: DiagnosticInfo<AstNode, string>
   ): ReturnType<TestValidator['toDiagnostic']> {
      return this.toDiagnostic(severity, message, info);
   }

   // Protected configuration fields, surfaced for the option-resolution tests.
   public get resolvedLogLevel(): LogThreshold {
      return this.logLevel.value;
   }
   public get resolvedLogAfterMs(): number {
      return this.logAfterMs.value;
   }
}

describe('HydraniumDocumentValidator', () => {
   describe('shouldSkipValidation', () => {
      it('default skips unmarked nodes (full validation runs)', () => {
         const validator = new TestValidator({ getAstNodePath: () => '/root' }, makeLogger());
         const result = validator.callValidateOptions(makeFakeAstNode({ $type: 'TypeOne' }));
         expect(result).toEqual({ validateNode: true, validateChildren: true });
      });

      it('default skips nodes marked $synthetic: true', () => {
         const node = makeFakeAstNode({ $type: 'TypeTwo' });
         (node as { $synthetic?: boolean }).$synthetic = true;
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger());
         expect(validator.callValidateOptions(node)).toEqual({ validateNode: false, validateChildren: false });
      });

      it('validates $synthetic nodes when validateSyntheticNodes is enabled', () => {
         const node = makeFakeAstNode({ $type: 'TypeTwo' });
         (node as { $synthetic?: boolean }).$synthetic = true;
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger(), undefined, {
            validateSyntheticNodes: true
         });
         expect(validator.callValidateOptions(node)).toEqual({ validateNode: true, validateChildren: true });
      });

      it('adopter override decides; predicate true skips both self and children', () => {
         const node = makeFakeAstNode({ $type: 'GeneratedRegion' });
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger(), n => n === node);
         expect(validator.callValidateOptions(node)).toEqual({ validateNode: false, validateChildren: false });
      });

      it('non-targeted siblings still validate normally under an adopter override', () => {
         const target = makeFakeAstNode({ $type: 'GeneratedRegion' });
         const real = makeFakeAstNode({ $type: 'UserNode' });
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger(), n => n === target);
         expect(validator.callValidateOptions(real)).toEqual({ validateNode: true, validateChildren: true });
      });
   });

   describe('toDiagnostic', () => {
      it('uses the AstNodeLocator path for `element`', () => {
         const node = makeFakeAstNode({ $type: 'Element' });
         const validator = new TestValidator({ getAstNodePath: target => (target === node ? '/members@2' : '') }, makeLogger());
         const diag = validator.callToDiagnostic('error', 'oops', diagnosticInfo(node));
         expect(diag.element).toBe('/members@2');
         expect(diag.property).toBeUndefined();
      });

      it('passes through info.property unchanged', () => {
         const node = makeFakeAstNode({ $type: 'TypeTwo' });
         const validator = new TestValidator({ getAstNodePath: () => '/members' }, makeLogger());
         const diag = validator.callToDiagnostic('warning', 'bad', diagnosticInfo(node, { property: 'name' }));
         expect(diag.property).toBe('name');
         expect(diag.element).toBe('/members');
      });

      it('appends the index when the path does not already include it', () => {
         const node = makeFakeAstNode({ $type: 'Reference' });
         const validator = new TestValidator({ getAstNodePath: () => '/parent' }, makeLogger());
         const diag = validator.callToDiagnostic('error', 'invalid', diagnosticInfo(node, { property: 'refs', index: 3 }));
         expect(diag.element).toBe(
            `/parent${TransferDiagnostic.ELEMENT_SEGMENT_SEPARATOR}refs${TransferDiagnostic.ELEMENT_INDEX_SEPARATOR}3`
         );
      });

      it('does not double-append the index when the path already ends with it', () => {
         const node = makeFakeAstNode({ $type: 'Reference' });
         const path = `/parent${TransferDiagnostic.ELEMENT_INDEX_SEPARATOR}3`;
         const validator = new TestValidator({ getAstNodePath: () => path }, makeLogger());
         const diag = validator.callToDiagnostic('error', 'invalid', diagnosticInfo(node, { property: 'refs', index: 3 }));
         expect(diag.element).toBe(path);
      });

      it('falls back to the container path when the node itself cannot be located', () => {
         const container = makeFakeAstNode({ $type: 'Element' });
         const node = makeFakeAstNode({ $type: 'SubElement', $container: container });
         const validator = new TestValidator({ getAstNodePath: target => (target === container ? '/container' : '') }, makeLogger());
         const diag = validator.callToDiagnostic('error', 'oops', diagnosticInfo(node, { property: 'ref', index: 0 }));
         expect(diag.element).toBe(
            `/container${TransferDiagnostic.ELEMENT_SEGMENT_SEPARATOR}ref${TransferDiagnostic.ELEMENT_INDEX_SEPARATOR}0`
         );
      });

      it('returns element "" and warns when the DiagnosticInfo carries no node', () => {
         // The validator warns through a `withUri`-derived tracer, so spy the prototype.
         const warnSpy = vi.spyOn(DefaultTracer.prototype, 'warn');
         const validator = new TestValidator({ getAstNodePath: () => '/should-not-be-used' }, makeLogger());
         const diag = validator.callToDiagnostic('error', 'oops', diagnosticInfo(undefined, { property: 'name' }));
         // `element` falls back to '' (mutant returning a sentinel/`{}` would not produce '').
         expect(diag.element).toBe('');
         expect(diag.property).toBe('name');
         // proves the no-node branch (not the happy path) executed
         expect(warnSpy).toHaveBeenCalled();
         expect(String(warnSpy.mock.calls[0][0])).toContain('DiagnosticInfo has no node');
         warnSpy.mockRestore();
      });

      it('appends only the index (no property segment) when info has an index but no property', () => {
         const node = makeFakeAstNode({ $type: 'Reference' });
         const validator = new TestValidator({ getAstNodePath: () => '/parent' }, makeLogger());
         const diag = validator.callToDiagnostic('error', 'invalid', diagnosticInfo(node, { index: 5 }));
         // Exercises the `info.property ? ... : ...` false branch -> bare index suffix.
         expect(diag.element).toBe(`/parent${TransferDiagnostic.ELEMENT_INDEX_SEPARATOR}5`);
      });

      it('returns element "" and warns when neither the node nor its container can be located', () => {
         const warnSpy = vi.spyOn(DefaultTracer.prototype, 'warn');
         const node = makeFakeAstNode({ $type: 'Orphan' });
         // getAstNodePath returns '' for everything -> directPath '' and containerPath ''.
         const validator = new TestValidator({ getAstNodePath: () => '' }, makeLogger());
         const diag = validator.callToDiagnostic('error', 'oops', diagnosticInfo(node, { property: 'name', index: 1 }));
         expect(diag.element).toBe('');
         expect(warnSpy).toHaveBeenCalled();
         expect(String(warnSpy.mock.calls[0][0])).toContain('Unable to determine AST node path');
         warnSpy.mockRestore();
      });
   });

   describe('validateDocument timing wrap', () => {
      // The validator wraps validation in `tracer.withUri(uri).time(...)`, and
      // `withUri` derives a fresh Tracer — so the wrap is observed by spying the
      // DefaultTracer prototype rather than the root instance.
      afterEach(() => vi.restoreAllMocks());

      function makeDoc(): LangiumDocument {
         return makeFakeDocument('memory:///doc.a', makeFakeAstNode({ $type: 'Root' }));
      }

      it('routes through logger.withUri().time() at the default debug level', async () => {
         const timeSpy = vi.spyOn(DefaultTracer.prototype, 'time');
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger());
         await validator.validateDocument(makeDoc());
         expect(timeSpy).toHaveBeenCalled();
      });

      it("bypasses the timing wrap when logLevel is 'off'", async () => {
         const timeSpy = vi.spyOn(DefaultTracer.prototype, 'time');
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger(), undefined, { logLevel: 'off' });
         await validator.validateDocument(makeDoc());
         expect(timeSpy).not.toHaveBeenCalled();
      });
   });

   describe('virtual-document validation', () => {
      afterEach(() => vi.restoreAllMocks());

      function makeDocAt(uri: string): LangiumDocument {
         return makeFakeDocument(uri, makeFakeAstNode({ $type: 'Root' }));
      }

      it('skips virtual documents by default (no validation run)', async () => {
         const timeSpy = vi.spyOn(DefaultTracer.prototype, 'time');
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger());
         const diagnostics = await validator.validateDocument(makeDocAt('virtual:stdlib'));
         expect(diagnostics).toEqual([]);
         expect(timeSpy).not.toHaveBeenCalled();
      });

      it('validates virtual documents when validateVirtualDocuments is enabled', async () => {
         const timeSpy = vi.spyOn(DefaultTracer.prototype, 'time');
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger(), undefined, {
            validateVirtualDocuments: true
         });
         await validator.validateDocument(makeDocAt('virtual:stdlib'));
         expect(timeSpy).toHaveBeenCalled();
      });

      it('reads validateVirtualDocuments per call so a bound observable retunes live', async () => {
         const timeSpy = vi.spyOn(DefaultTracer.prototype, 'time');
         let enabled = false;
         const flag = {
            get value() {
               return enabled;
            },
            onChange: () => Disposable.EMPTY
         };
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger(), undefined, {
            validateVirtualDocuments: flag
         });
         await validator.validateDocument(makeDocAt('virtual:stdlib'));
         expect(timeSpy).not.toHaveBeenCalled(); // skipped while false
         enabled = true;
         await validator.validateDocument(makeDocAt('virtual:stdlib'));
         expect(timeSpy).toHaveBeenCalledTimes(1); // now validated
      });

      it('validates on-disk documents regardless of the flag', async () => {
         const timeSpy = vi.spyOn(DefaultTracer.prototype, 'time');
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger());
         await validator.validateDocument(makeDocAt('file:///a/b.a'));
         expect(timeSpy).toHaveBeenCalled();
      });
   });

   describe('option resolution', () => {
      it('uses framework defaults when no options supplied', () => {
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger());
         expect(validator.resolvedLogLevel).toBe('debug');
         expect(validator.resolvedLogAfterMs).toBe(20);
      });

      it('overrides a single option, leaving the rest at defaults', () => {
         const validator = new TestValidator({ getAstNodePath: () => '/x' }, makeLogger(), undefined, { logAfterMs: 100 });
         expect(validator.resolvedLogAfterMs).toBe(100);
         expect(validator.resolvedLogLevel).toBe('debug');
      });
   });

   /**
    * The pass has three exits and only the attaching one is observable from an
    * example, because every other exit produces a diagnostic that looks exactly
    * like Langium's. So they are enumerated from the code here rather than
    * inferred from the sentences a grammar happens to produce.
    */
   describe('processLinkingErrors', () => {
      /** Langium's own `data` for a linking error, whose shape every arm shares. */
      const LINKING_DATA = { code: 'linking-error', containerType: 'Holder', property: 'target', refText: 'Foo' };

      /** A document carrying one linking error worded `message`, as `DefaultLinker` leaves it. */
      function documentWith(message: string): LangiumDocument {
         return {
            references: [
               {
                  $refText: LINKING_DATA.refText,
                  $refNode: undefined,
                  error: {
                     info: {
                        container: { $type: LINKING_DATA.containerType },
                        property: LINKING_DATA.property,
                        reference: { $refText: LINKING_DATA.refText }
                     },
                     message
                  }
               }
            ]
         } as unknown as LangiumDocument;
      }

      /** Exposes the protected pass, which has no public caller to drive it through. */
      class PassProbe extends HydraniumDocumentValidator {
         run(target: LangiumDocument, into: Diagnostic[]): void {
            this.processLinkingErrors(target, into, {});
         }
      }

      function makeProbe(getReferenceType: () => string): PassProbe {
         return new PassProbe(makeStubServices({ getAstNodePath: () => '/x' }, makeLogger(), getReferenceType));
      }

      function runPass(document: LangiumDocument, getReferenceType: () => string): Diagnostic[] {
         const diagnostics: Diagnostic[] = [];
         makeProbe(getReferenceType).run(document, diagnostics);
         return diagnostics;
      }

      /** Byte-identical to `DefaultLinker.createLinkingError`'s sentence, which is the contract. */
      const STANDARD = "Could not resolve reference to Entity named 'Foo'.";

      it('attaches the identity to the sentence the declaration renders', () => {
         const [diagnostic] = runPass(documentWith(STANDARD), () => 'Entity');

         expect(diagnostic.code).toBe(UNRESOLVED_REFERENCE.code);
         // Merged OVER Langium's data, which `stopAfterLinkingErrors` reads.
         expect(diagnostic.data).toMatchObject({ code: 'linking-error', hydranium: { code: UNRESOLVED_REFERENCE.code } });
      });

      it('declines the linker EXCEPTION form, whose data is shape-identical', () => {
         // Raised when resolution itself threw. Labelling it would let a
         // catalogue render "could not resolve" over it and discard the cause
         // that is the whole content of the message.
         const [diagnostic] = runPass(documentWith("An error occurred while resolving reference to 'Foo': boom"), () => 'Entity');

         expect(diagnostic.code).toBeUndefined();
         expect(diagnostic.data).not.toHaveProperty('hydranium');
      });

      it("declines an adopter's reworded createLinkingError", () => {
         const [diagnostic] = runPass(documentWith("No Entity called 'Foo' is in scope."), () => 'Entity');

         expect(diagnostic.code).toBeUndefined();
      });

      it('declines rather than throwing when the reflection cannot name the reference type', () => {
         // `getReferenceType` raises on an unknown container `$type` and on a
         // non-reference property, and the diagnostic most likely to reach here
         // is one whose lookup ALREADY failed inside `DefaultLinker` — which is
         // why the guard cannot sit after the message comparison. Langium wraps
         // `processLinkingErrors` in no try, so a rethrow fails the whole
         // validation for the document.
         let diagnostics: Diagnostic[] = [];
         expect(() => {
            diagnostics = runPass(documentWith(STANDARD), () => {
               throw new Error('Type Holder not found.');
            });
         }).not.toThrow();

         // The diagnostic still arrives, unidentified — asserted rather than
         // just the absence of a throw, because a swallowed error that also
         // dropped the entry would satisfy `not.toThrow()` too.
         expect(diagnostics).toHaveLength(1);
         expect(diagnostics[0].message).toBe(STANDARD);
         expect(diagnostics[0].code).toBeUndefined();
      });

      it('leaves diagnostics that were already in the list untouched', () => {
         // The pass identifies only what `super` appended, so a parser error
         // sitting in the list ahead of it cannot be relabelled.
         const preexisting: Diagnostic = { range: Range.create(0, 0, 0, 0), message: STANDARD, data: LINKING_DATA };
         const diagnostics: Diagnostic[] = [preexisting];

         makeProbe(() => 'Entity').run(documentWith(STANDARD), diagnostics);

         expect(diagnostics[0]).toBe(preexisting);
         expect(diagnostics[0].code).toBeUndefined();
      });
   });

   describe('identifyLexingError', () => {
      /**
       * A source whose second line begins with a character no token can start
       * with, and the offset the lexer reports for it.
       *
       * Two lines, not one, so the range→offset round trip the pass depends on
       * actually crosses a line break — a single-line fixture makes
       * `offsetAt(start)` and `range.start.character` the same number, and would
       * pass against a pass that used the column as the offset.
       */
      const SOURCE = 'element Foo\n§ trailing';
      const OFFSET = SOURCE.indexOf('§');

      /**
       * The range Langium's `processLexingErrors` computes for a one-character
       * lexer error on the second line: `line - 1`, `column - 1`, and an end one
       * character further on.
       */
      const STRAY_RANGE = Range.create(1, 0, 1, 1);

      /**
       * Byte-identical to chevrotain's
       * `defaultLexerErrorProvider.buildUnexpectedCharactersMessage`, which is
       * the contract {@link LEXING_ERROR} claims.
       */
      const CHEVROTAIN = `unexpected character: ->§<- at offset: ${OFFSET}, skipped 1 characters.`;

      /** Exposes the protected pass, which its caller reaches only through a full validation. */
      class LexingProbe extends HydraniumDocumentValidator {
         run(target: LangiumDocument, diagnostic: Diagnostic): Diagnostic {
            return this.identifyLexingError(target, diagnostic);
         }
      }

      /**
       * A document over {@link SOURCE} with a REAL `TextDocument` behind it.
       *
       * The fake's default `textDocument` has no `offsetAt`, and stubbing one
       * would be stubbing the very computation under test: the pass reconstructs
       * chevrotain's offset from an LSP range, and only upstream's own position
       * arithmetic can say whether that round-trips.
       */
      function document(): LangiumDocument {
         return makeFakeDocument('file:///a.test', makeFakeAstNode({ $type: 'Root' }), {
            textDocument: TextDocument.create('file:///a.test', 'test', 1, SOURCE)
         });
      }

      function runPass(diagnostic: Diagnostic): Diagnostic {
         return new LexingProbe(makeStubServices({ getAstNodePath: () => '/x' }, makeLogger())).run(document(), diagnostic);
      }

      function lexingDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
         return { range: STRAY_RANGE, message: CHEVROTAIN, data: { code: 'lexing-error' }, ...overrides };
      }

      it('attaches the identity, with the character and offset a translation needs', () => {
         const diagnostic = runPass(lexingDiagnostic());

         expect(diagnostic.code).toBe(LEXING_ERROR.code);
         // The PARAMS, not just the code: an identity with no character is the
         // half-measure this whole pass exists to avoid, and it would render a
         // German sentence with a literal `{character}` in it.
         expect(diagnostic.data).toMatchObject({
            code: 'lexing-error',
            hydranium: { code: LEXING_ERROR.code, params: { character: '§', offset: OFFSET, skipped: 1 } }
         });
      });

      it('renders back to chevrotain’s own sentence, so an adopter with no catalogue is unaffected', () => {
         const diagnostic = runPass(lexingDiagnostic());
         const params = (diagnostic.data as { hydranium: { params: Parameters<typeof LEXING_ERROR.format>[0] } }).hydranium.params;

         expect(LEXING_ERROR.format(params)).toBe(CHEVROTAIN);
      });

      it('identifies a lexing WARNING too, not only the error severity', () => {
         // `lexerReport` admits warnings and below, and a token builder that
         // downgrades a stray character still produces the same sentence.
         const diagnostic = runPass(lexingDiagnostic({ data: { code: 'lexing-warning' } }));

         expect(diagnostic.code).toBe(LEXING_ERROR.code);
      });

      it("declines a custom lexer's own diagnostic, which carries the same code", () => {
         // The shape a `lexerReport` entry from an indentation-aware lexer has:
         // Langium's lexing code, arbitrary prose. Labelling it would have a
         // catalogue render "unexpected character" over an unrelated report.
         const diagnostic = runPass(lexingDiagnostic({ message: 'Inconsistent indentation: expected 3 spaces.' }));

         expect(diagnostic.code).toBeUndefined();
         expect(diagnostic.data).not.toHaveProperty('hydranium');
      });

      it('declines a non-lexing diagnostic whose message is identical', () => {
         // The guard the code check exists for. A parsing error cannot word
         // itself this way today, so nothing but the code separates "the lexer
         // said this" from "something else said the same thing" — and an
         // adopter validator is free to say anything.
         const diagnostic = runPass(lexingDiagnostic({ data: { code: 'parsing-error' } }));

         expect(diagnostic.code).toBeUndefined();
      });

      it('declines when the range does not round-trip to the reported offset', () => {
         // The reconstruction validating itself. A range one line off yields a
         // different offset and therefore a different sentence, so a wrong
         // parameter set can never be attached to a right-looking message —
         // which is what makes reading the range safe in place of correlating
         // Langium's own error list.
         const diagnostic = runPass(lexingDiagnostic({ range: Range.create(0, 0, 0, 1) }));

         expect(diagnostic.code).toBeUndefined();
      });
   });
});
