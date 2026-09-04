/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { type AstNode, type AstReflection, DocumentState, type LangiumDocument, URI } from '@hydranium/langium';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { makeFakeAstNode, makeFakeDocument } from '../../../src/testing/fake-document.js';
import { makeFakeReflection, makeNoopSharedServices, makeTestServices } from '../../../src/testing/index.js';
import { makeStubDocumentBuilder } from '../../../src/testing/stub-document-builder.js';
import {
   type EncodeContext,
   TransferEncoder,
   type TransferEnvelopeSource,
   type TransferMode
} from '../../../src/langium/transfer/transfer-encoder.js';
import type { TransferLspDiagnostic } from '../../../src/langium/validation/document-validator.js';
import type { TransferDiagnostic, TransferDocument, TransferElement, TransferTypeFor } from '@hydranium/protocol';

function buildEncoder(reflection: AstReflection): TransferEncoder {
   const services = makeNoopSharedServices({
      AstReflection: reflection,
      // toTransferDocument's internal root cache subscribes to build phases
      workspace: { DocumentBuilder: makeStubDocumentBuilder() }
   });
   return new TransferEncoder(services);
}

/** Build a Langium `Reference`-shaped value carrying just the `$refText`. */
function ref(refText: string): unknown {
   return { $refText: refText, $refNode: undefined, ref: undefined, error: undefined };
}

describe('TransferEncoder.toTransfer', () => {
   describe("'grammar' mode (persisted-shape projection)", () => {
      it('keeps only grammar-declared properties, dropping computed/synthetic own props', () => {
         const encoder = buildEncoder(makeFakeReflection({ Element: { id: {}, name: {} } }));
         const node = { $type: 'Element', id: 'E1', name: 'E1', _globalId: 'ns.E1' };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({
            $type: 'Element',
            id: 'E1',
            name: 'E1'
         });
      });

      it('always carries $type even for a node with no declared properties', () => {
         const encoder = buildEncoder(makeFakeReflection({ Empty: {} }));
         expect(encoder.toTransfer(makeFakeAstNode({ $type: 'Empty', _id: 'x' }), 'grammar')).toEqual({ $type: 'Empty' });
      });

      it('resolves a Langium Reference value to its $refText', () => {
         const encoder = buildEncoder(makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }));
         const node = { $type: 'Edge', target: ref('someId') };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({ $type: 'Edge', target: 'someId' });
      });

      it('resolves an array of References to an array of $refText', () => {
         const encoder = buildEncoder(makeFakeReflection({ Group: { members: { referenceType: 'TypeTwo' } } }));
         const node = { $type: 'Group', members: [ref('a'), ref('b')] };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({ $type: 'Group', members: ['a', 'b'] });
      });

      it('recurses into nested AST nodes, keeping only their declared properties', () => {
         const encoder = buildEncoder(
            makeFakeReflection({
               Root: { child: {} },
               Element: { id: {} }
            })
         );
         const node = {
            $type: 'Root',
            child: { $type: 'Element', id: 'C', _globalId: 'g', _isPrimaryIdentifier: true }
         };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({
            $type: 'Root',
            child: { $type: 'Element', id: 'C' }
         });
      });

      it('recurses into arrays of nested AST nodes', () => {
         const encoder = buildEncoder(
            makeFakeReflection({
               Element: { members: {} },
               SubElement: { id: {}, name: {} }
            })
         );
         const node = {
            $type: 'Element',
            members: [
               { $type: 'SubElement', id: 'a', name: 'a1', _globalId: 'g1' },
               { $type: 'SubElement', id: 'b', name: 'b1', _isPrimaryIdentifier: false }
            ]
         };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({
            $type: 'Element',
            members: [
               { $type: 'SubElement', id: 'a', name: 'a1' },
               { $type: 'SubElement', id: 'b', name: 'b1' }
            ]
         });
      });

      it('drops a synthetic child array that is not grammar-declared', () => {
         const encoder = buildEncoder(makeFakeReflection({ ElementNode: { id: {}, x: {}, y: {} } }));
         const node = {
            $type: 'ElementNode',
            id: 'N1',
            x: 10,
            y: 20,
            _members: [{ $type: 'ElementNodeChild', id: 'mirror' }]
         };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({ $type: 'ElementNode', id: 'N1', x: 10, y: 20 });
      });

      it('skips grammar-declared properties absent on the node', () => {
         const encoder = buildEncoder(makeFakeReflection({ Root: { child: {}, absentA: {}, absentB: {} } }));
         const node = { $type: 'Root', child: { $type: 'X' } };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({
            $type: 'Root',
            child: { $type: 'X' }
         });
      });

      it('preserves primitive values including falsy ones and primitive arrays', () => {
         const encoder = buildEncoder(makeFakeReflection({ TypeOne: { mandatory: {}, length: {}, name: {}, tags: {} } }));
         const node = { $type: 'TypeOne', mandatory: true, length: 0, name: '', tags: ['a', 'b'] };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'grammar')).toEqual({
            $type: 'TypeOne',
            mandatory: true,
            length: 0,
            name: '',
            tags: ['a', 'b']
         });
      });

      it('does not mutate the input (returns an independent deep copy)', () => {
         const encoder = buildEncoder(
            makeFakeReflection({
               X: { id: {}, child: {} },
               Child: { id: {} }
            })
         );
         const node = {
            $type: 'X',
            id: 'a',
            _globalId: 'g',
            child: { $type: 'Child', id: 'c', _globalId: 'h' }
         };

         const result = encoder.toTransfer(makeFakeAstNode(node), 'grammar') as unknown as Record<string, unknown>;

         // input retains its computed properties — the projection is non-destructive
         expect((node as Record<string, unknown>)._globalId).toBe('g');
         expect((node.child as Record<string, unknown>)._globalId).toBe('h');
         // result is a distinct object graph
         expect(result.child).not.toBe(node.child);
      });
   });

   describe("'full' mode (default)", () => {
      it('includes computed/synthetic own properties the grammar walk drops', () => {
         const encoder = buildEncoder(makeFakeReflection({ Element: { id: {} } }));
         const node = { $type: 'Element', id: 'C', _globalId: 'ns.C', _members: [{ $type: 'M', id: 'm' }] };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'full')).toEqual({
            $type: 'Element',
            id: 'C',
            _globalId: 'ns.C',
            _members: [{ $type: 'M', id: 'm' }]
         });
      });

      it('defaults to full when no mode is given', () => {
         const encoder = buildEncoder(makeFakeReflection({ Element: { id: {} } }));
         const node = { $type: 'Element', id: 'C', _globalId: 'ns.C' };

         expect(encoder.toTransfer(makeFakeAstNode(node))).toEqual({ $type: 'Element', id: 'C', _globalId: 'ns.C' });
      });

      it('still strips Langium internals and resolves references', () => {
         const encoder = buildEncoder(makeFakeReflection({ Edge: {} }));
         const node = { $type: 'Edge', target: ref('someId'), $container: { circular: true } };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'full')).toEqual({ $type: 'Edge', target: 'someId' });
      });

      it('passes a null property value through without dereferencing it', () => {
         // `toTransferValue` probes with `isReference` / `isAstNode`, both of
         // which reject `null` before touching a property on it. A hand-rolled
         // probe of the form `typeof value === 'object' && '$type' in value`
         // would throw here instead of passing the value through.
         const encoder = buildEncoder(makeFakeReflection({ Node: { parent: {} } }));
         const node = { $type: 'Node', parent: null };

         expect(encoder.toTransfer(makeFakeAstNode(node), 'full')).toEqual({ $type: 'Node', parent: null });
      });
   });
});

describe('TransferEncoder.toTransferDiagnostic', () => {
   function diag(overrides: Partial<TransferLspDiagnostic> = {}): TransferLspDiagnostic {
      return {
         range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
         message: 'boom',
         element: 'el',
         severity: DiagnosticSeverity.Error,
         ...overrides
      } as TransferLspDiagnostic;
   }

   it("maps data.code 'lexing-error' to type 'lexing-error'", () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      const result = encoder.toTransferDiagnostic(diag({ data: { code: 'lexing-error' } } as unknown as TransferLspDiagnostic));
      expect(result.type).toBe('lexing-error');
      // code falls back to langiumCode when diagnostic.code is absent
      expect(result.code).toBe('lexing-error');
   });

   it("maps data.code 'parsing-error' to type 'parsing-error'", () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      const result = encoder.toTransferDiagnostic(diag({ data: { code: 'parsing-error' } } as unknown as TransferLspDiagnostic));
      expect(result.type).toBe('parsing-error');
   });

   it("maps an unknown / absent data.code to type 'validation-error'", () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      expect(encoder.toTransferDiagnostic(diag()).type).toBe('validation-error');
      expect(encoder.toTransferDiagnostic(diag({ data: { code: 'something-else' } } as unknown as TransferLspDiagnostic)).type).toBe(
         'validation-error'
      );
   });

   it('maps Error severity to "error"', () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      expect(encoder.toTransferDiagnostic(diag({ severity: DiagnosticSeverity.Error })).severity).toBe('error');
   });

   it('maps Warning severity to "warning"', () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      expect(encoder.toTransferDiagnostic(diag({ severity: DiagnosticSeverity.Warning })).severity).toBe('warning');
   });

   it('maps Information / undefined severity to "info"', () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      expect(encoder.toTransferDiagnostic(diag({ severity: DiagnosticSeverity.Information })).severity).toBe('info');
      expect(encoder.toTransferDiagnostic(diag({ severity: undefined })).severity).toBe('info');
   });

   it('passes through element, property and message', () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      const result = encoder.toTransferDiagnostic(diag({ element: '/root@1', property: 'name', message: 'bad name' }));
      expect(result.element).toBe('/root@1');
      expect(result.property).toBe('name');
      expect(result.message).toBe('bad name');
   });

   it('falls back element to empty string when the diagnostic carries no element', () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      const result = encoder.toTransferDiagnostic(diag({ element: undefined }));
      expect(result.element).toBe('');
   });

   it('prefers a numeric diagnostic.code over the langiumCode fallback', () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      const result = encoder.toTransferDiagnostic(diag({ code: 42, data: { code: 'lexing-error' } } as unknown as TransferLspDiagnostic));
      expect(result.code).toBe(42);
   });

   it('prefers a string diagnostic.code over the langiumCode fallback', () => {
      const encoder = buildEncoder(makeFakeReflection({}));
      const result = encoder.toTransferDiagnostic(
         diag({ code: 'E123', data: { code: 'lexing-error' } } as unknown as TransferLspDiagnostic)
      );
      expect(result.code).toBe('E123');
   });
});

describe('TransferEncoder.toTransferDocument', () => {
   it('bundles root + diagnostics + uri/version from a LangiumDocument', () => {
      const encoder = buildEncoder(makeFakeReflection({ Root: { id: {} } }));
      const langiumDocument = {
         uri: URI.parse('file:///a.a'),
         parseResult: { value: { $type: 'Root', id: 'r', _computed: 'x' } },
         textDocument: { uri: 'file:///a.a', version: 7 },
         diagnostics: [
            {
               range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
               message: 'oops',
               element: '/root',
               severity: DiagnosticSeverity.Warning
            }
         ]
      } as unknown as LangiumDocument;

      const result = encoder.toTransferDocument(langiumDocument);
      expect(result.uri).toBe('file:///a.a');
      expect(result.version).toBe(7);
      // full mode default keeps computed props
      expect(result.root).toEqual({ $type: 'Root', id: 'r', _computed: 'x' });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].severity).toBe('warning');
      expect(result.diagnostics[0].element).toBe('/root');
   });

   it('produces an empty diagnostics array when the document has none (undefined)', () => {
      const encoder = buildEncoder(makeFakeReflection({ Root: {} }));
      const langiumDocument = {
         uri: URI.parse('file:///b.a'),
         parseResult: { value: { $type: 'Root' } },
         textDocument: { uri: 'file:///b.a', version: 1 },
         diagnostics: undefined
      } as unknown as LangiumDocument;

      const result = encoder.toTransferDocument(langiumDocument);
      expect(result.diagnostics).toEqual([]);
   });
});

describe('TransferEncoder.toTransferDocument (internal root cache)', () => {
   it('memoizes the root per document and recomputes after a Linked-phase rebuild', () => {
      const bundle = makeTestServices();
      const encoder = bundle.transferEncoder;
      const document = makeFakeDocument('file:///A.fake', { $type: 'A', name: 'a' });
      // Spy on the recursion core (`encodeNode`): the document entry point
      // creates the encode context itself, so it does not route through the
      // public `toTransfer` door.
      const spy = vi.spyOn(encoder as unknown as { encodeNode: (...args: unknown[]) => unknown }, 'encodeNode');

      const first = encoder.toTransferDocument(document);
      const second = encoder.toTransferDocument(document);
      // the encode walk ran once; the second envelope reused the cached root
      expect(spy).toHaveBeenCalledTimes(1);
      expect(second.root).toBe(first.root);

      // a (cascade or direct) rebuild drives the document through Linked; the
      // cache must evict so the next read recomputes against the new derived state
      bundle.documentBuilder.firePhase(DocumentState.Linked, document);

      encoder.toTransferDocument(document);
      expect(spy).toHaveBeenCalledTimes(2);
   });

   it('separates cache entries when rootCacheKey folds in an output-affecting context input', () => {
      // The shape the seam exists for: a per-encode input resolved into the
      // context that changes the encoded output. Without it in the key, the
      // first caller's root would be served to the second.
      interface LabelledContext extends EncodeContext {
         readonly label: string;
      }
      let label = 'short';
      class LabellingEncoder extends TransferEncoder {
         protected override createEncodeContext(mode: TransferMode, uri?: string): LabelledContext {
            return { mode, uri, label };
         }

         protected override rootCacheKey(context: LabelledContext): string {
            return `${context.mode}:${context.label}`;
         }

         protected override finalizeTransferNode(_ast: AstNode, result: Record<string, unknown>, context: LabelledContext): void {
            result._label = context.label;
         }
      }

      const bundle = makeTestServices();
      const encoder = new LabellingEncoder(bundle.services);
      const document = makeFakeDocument('file:///A.fake', { $type: 'A', name: 'a' });

      const first = encoder.toTransferDocument(document);
      expect((first.root as unknown as Record<string, unknown>)._label).toBe('short');

      label = 'long';
      const second = encoder.toTransferDocument(document);
      expect((second.root as unknown as Record<string, unknown>)._label).toBe('long');

      // Back to the first context: still cached, so it is the SAME object, not a re-encode.
      label = 'short';
      expect(encoder.toTransferDocument(document).root).toBe(first.root);
   });
});

describe('TransferEncoder.astDocumentToTransferDocument', () => {
   it('bundles root + diagnostics + uri/version from an AstDocument snapshot', () => {
      const encoder = buildEncoder(makeFakeReflection({ Root: { id: {} } }));
      const astDocument = {
         uri: 'file:///c.a',
         version: 3,
         root: { $type: 'Root', id: 'r', _computed: 'y' },
         diagnostics: [
            {
               range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
               message: 'bad',
               element: '/root',
               severity: DiagnosticSeverity.Error
            }
         ]
      } as unknown as Parameters<TransferEncoder['astDocumentToTransferDocument']>[0];

      const result = encoder.astDocumentToTransferDocument(astDocument);
      expect(result.uri).toBe('file:///c.a');
      expect(result.version).toBe(3);
      expect(result.root).toEqual({ $type: 'Root', id: 'r', _computed: 'y' });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].severity).toBe('error');
      expect(result.diagnostics[0].element).toBe('/root');
   });
});

describe('TransferEncoder.assembleTransferDocument', () => {
   /**
    * Rewrites the root on its way into the envelope. One override has to cover
    * EVERY envelope the encoder emits, or the paths it misses ship the raw
    * root.
    */
   class TaggingEncoder extends TransferEncoder {
      protected override assembleTransferDocument<TAst extends AstNode>(
         source: TransferEnvelopeSource<TransferDiagnostic>,
         root: TransferTypeFor<TAst, Record<string, TransferElement>>
      ): TransferDocument<TransferTypeFor<TAst, Record<string, TransferElement>>, TransferDiagnostic> {
         const tagged = { ...(root as object), _assembled: true } as unknown as TransferTypeFor<TAst, Record<string, TransferElement>>;
         return super.assembleTransferDocument<TAst>(source, tagged);
      }
   }

   function buildTaggingEncoder(): TaggingEncoder {
      const services = makeNoopSharedServices({
         AstReflection: makeFakeReflection({ Root: { id: {} } }),
         workspace: { DocumentBuilder: makeStubDocumentBuilder() }
      });
      return new TaggingEncoder(services);
   }

   it('is the chokepoint for the live-document path', () => {
      const encoder = buildTaggingEncoder();
      const document = makeFakeDocument('file:///live.fake', { $type: 'Root', id: 'r' });

      const result = encoder.toTransferDocument(document);
      expect((result.root as unknown as Record<string, unknown>)._assembled).toBe(true);
   });

   it('is the chokepoint for the AstDocument snapshot path too', () => {
      const encoder = buildTaggingEncoder();
      const astDocument = { uri: 'file:///snap.a', version: 7, root: makeFakeAstNode({ $type: 'Root', id: 'r' }), diagnostics: [] };

      const result = encoder.astDocumentToTransferDocument(astDocument);
      // Guards the two-path split: were this path to build the envelope inline
      // instead of delegating, an adopter override of the documented seam would
      // silently miss every facade return.
      expect((result.root as unknown as Record<string, unknown>)._assembled).toBe(true);
      expect(result.uri).toBe('file:///snap.a');
      expect(result.version).toBe(7);
   });
});

describe('TransferEncoder extension hooks', () => {
   /** Widened context carrying a per-encode input resolved at context-creation time. */
   interface HookedContext extends EncodeContext {
      readonly stamp: string;
   }

   /**
    * Exercises every walk hook: context widening, per-key filtering, value
    * substitution, and node post-decoration reading the widened context.
    */
   class HookedEncoder extends TransferEncoder {
      protected override createEncodeContext(mode: TransferMode, uri?: string): HookedContext {
         return { mode, uri, stamp: uri ? `@${uri}` : '@detached' };
      }

      protected override shouldEmitProperty(astNode: AstNode, key: string, context: EncodeContext): boolean {
         return super.shouldEmitProperty(astNode, key, context) && key !== 'hidden';
      }

      protected override resolvePropertyValue(astNode: AstNode, key: string, context: EncodeContext): unknown {
         const value = super.resolvePropertyValue(astNode, key, context);
         return key === 'name' ? `${value}!` : value;
      }

      protected override finalizeTransferNode(astNode: AstNode, result: Record<string, unknown>, context: HookedContext): void {
         if (context.mode === 'full') {
            result._decorated = context.stamp;
         }
      }
   }

   function buildHookedEncoder(): HookedEncoder {
      const services = makeNoopSharedServices({
         AstReflection: makeFakeReflection({ Root: { name: {} } }),
         workspace: { DocumentBuilder: makeStubDocumentBuilder() }
      });
      return new HookedEncoder(services);
   }

   it('shouldEmitProperty filters keys on top of the default $-internals strip', () => {
      const encoder = buildHookedEncoder();
      const node = makeFakeAstNode({ $type: 'Root', name: 'a', hidden: 'nope' });
      const result = encoder.toTransfer(node) as unknown as Record<string, unknown>;
      expect(result.hidden).toBeUndefined();
      expect(result.name).toBe('a!');
   });

   it('resolvePropertyValue substitutes values without copying the walk', () => {
      const encoder = buildHookedEncoder();
      const node = makeFakeAstNode({ $type: 'Root', name: 'a', other: 1 });
      const result = encoder.toTransfer(node) as unknown as Record<string, unknown>;
      expect(result.name).toBe('a!');
      expect(result.other).toBe(1);
   });

   it("finalizeTransferNode decorates every encoded node in 'full' mode, including nested ones", () => {
      const encoder = buildHookedEncoder();
      const node = makeFakeAstNode({ $type: 'Root', name: 'a', child: { $type: 'Root', name: 'c' } });
      const result = encoder.toTransfer(node) as unknown as Record<string, unknown>;
      expect(result._decorated).toBe('@detached');
      expect((result.child as Record<string, unknown>)._decorated).toBe('@detached');
   });

   it("finalizeTransferNode stays out of the 'grammar' shape", () => {
      const encoder = buildHookedEncoder();
      const node = makeFakeAstNode({ $type: 'Root', name: 'a' });
      const result = encoder.toTransfer(node, 'grammar') as unknown as Record<string, unknown>;
      expect(result._decorated).toBeUndefined();
   });

   it('threads the document URI into the context through the document entry point', () => {
      const services = makeNoopSharedServices({
         AstReflection: makeFakeReflection({ Root: { name: {} } }),
         workspace: { DocumentBuilder: makeStubDocumentBuilder() }
      });
      const encoder = new HookedEncoder(services);
      const astDocument = { uri: 'file:///ctx.a', version: 1, root: makeFakeAstNode({ $type: 'Root', name: 'a' }), diagnostics: [] };
      const result = encoder.astDocumentToTransferDocument(astDocument);
      expect((result.root as unknown as Record<string, unknown>)._decorated).toBe('@file:///ctx.a');
   });

   it('derives the URI from an attached node through the bare toTransfer door', () => {
      const encoder = buildHookedEncoder();
      const document = makeFakeDocument('file:///attached.fake', { $type: 'Root', name: 'a' });
      const result = encoder.toTransfer(document.parseResult.value) as unknown as Record<string, unknown>;
      expect(result._decorated).toBe('@file:///attached.fake');
   });
});
