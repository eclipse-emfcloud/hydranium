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
import { Range } from 'vscode-languageserver-types';
import { HydraniumDocumentValidator, type DocumentValidatorOptions } from '../../../src/langium/validation/document-validator.js';
import { makeFakeAstNode, makeFakeDocument, makeNoopTracer } from '../../../src/testing/index.js';

function makeLogger(): Tracer {
   return makeNoopTracer();
}

interface PathProvider {
   getAstNodePath(node: AstNode): string;
}

function makeStubServices(astNodeLocator: PathProvider, logger: Logger): LangiumCoreServices & { shared: { Tracer: Tracer } } {
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
         AstReflection: { getReferenceType: () => 'Fake', isSubtype: () => true }
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
});
