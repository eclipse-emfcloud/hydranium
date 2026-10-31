/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type CstNode, DocumentState, type LangiumDocument, type LinkingError, URI } from '@hydranium/langium';
import { asMutable, Disposable, type Tracer } from '@hydranium/protocol';
import { DefaultModelLedger } from '../../../src/documents/model-ledger.js';
import { type FakeClock, makeFakeClock } from '@hydranium/protocol/testing';
import {
   CST_REHYDRATION_RESET_STATE,
   DefaultCstResidencyService,
   type CstResidencyOptions,
   isCstShed
} from '../../../src/langium/residency/cst-residency-service.js';
import { makeFakeAstNode, makeFakeReflection, makeNoopSharedServices } from '../../../src/testing/index.js';

/** A build-phase pass captured at registration time so the test can drive its `run`. */
interface CapturedPass {
   run(documents: readonly LangiumDocument[]): void;
}

/** Build a service over stub shared services; returns the captured pass, the fake clock, and mutable test knobs. */
function makeService(
   options: CstResidencyOptions,
   Service: typeof DefaultCstResidencyService = DefaultCstResidencyService
): {
   service: DefaultCstResidencyService;
   pass: CapturedPass;
   open: Set<string>;
   clock: FakeClock;
   traces: string[];
   ledger: DefaultModelLedger;
   addDoc: (uriText: string, recorded?: boolean) => LangiumDocument;
   parses: () => number;
} {
   const open = new Set<string>();
   const docs = new Map<string, LangiumDocument>();
   const clock = makeFakeClock();
   let captured: CapturedPass | undefined;
   const traces: string[] = [];
   const ledger = new DefaultModelLedger();
   let parseCount = 0;
   const tracer = {
      for: () => tracer,
      trace: () => tracer,
      debug: (message: string) => {
         traces.push(message);
         return tracer;
      }
   } as unknown;
   const services = makeNoopSharedServices({
      Clock: clock,
      Tracer: tracer as Tracer,
      workspace: {
         TextDocuments: { isOpenInAnyClient: (uri: string) => open.has(uri) },
         LangiumDocuments: { getDocument: (uri: URI) => docs.get(uri.toString()) },
         ModelLedger: ledger,
         // A one-node parse, so every graft of the two-node document diverges.
         LangiumDocumentFactory: {
            fromString: () => {
               parseCount++;
               return { parseResult: { value: { $type: 'Root' } } };
            }
         },
         BuildPhasePassService: {
            register: (pass: CapturedPass) => {
               captured = pass;
               return Disposable.EMPTY;
            }
         }
      }
   });
   const service = new Service(services, options);
   if (!captured) {
      throw new Error('CstResidencyService did not register a build-phase pass');
   }
   // Recorded, as every root the framework's factory parses is.
   const addDoc = (uriText: string, recorded = true): LangiumDocument => {
      const document = makeDocument(uriText);
      if (recorded) {
         ledger.record(document.parseResult.value, 1);
      }
      docs.set(document.uri.toString(), document);
      return document;
   };
   return { service, pass: captured, open, clock, traces, ledger, addDoc, parses: () => parseCount };
}

/** A two-node AST document with CST attached to every node and one reference. */
function makeDocument(uriText: string): LangiumDocument {
   const child: Record<string, unknown> = { $type: 'Child', $cstNode: {} };
   const root: Record<string, unknown> = { $type: 'Root', $cstNode: { root: { fullText: 'root' } }, child };
   child.$container = root;
   return {
      uri: URI.parse(uriText),
      state: DocumentState.Validated,
      parseResult: { value: root },
      textDocument: { getText: () => 'root' },
      references: [{ $refNode: {} }]
   } as unknown as LangiumDocument;
}

function cstNodeCount(document: LangiumDocument): number {
   const root = document.parseResult.value as { $cstNode?: unknown; child?: { $cstNode?: unknown } };
   return (root.$cstNode ? 1 : 0) + (root.child?.$cstNode ? 1 : 0);
}

describe('CstResidencyService', () => {
   it('always-keep is a no-op (CST retained for a closed document, no timer armed)', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'always-keep' } });
      const doc = addDoc('file:///a.a');
      pass.run([doc]);
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('shed-closed-when-idle (idleMs 0) sheds CST and $refNode of a closed document on the next tick', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const doc = addDoc('file:///a.a');
      pass.run([doc]);
      expect(cstNodeCount(doc)).toBe(2); // armed, not yet fired
      clock.advance(1);
      expect(cstNodeCount(doc)).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((doc.references[0] as any).$refNode).toBeUndefined();
   });

   it('keeps the CST of a document open in a client (timer cancelled)', () => {
      const { pass, clock, open, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const doc = addDoc('file:///open.a');
      open.add('file:///open.a');
      pass.run([doc]);
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('does not shed a synthetic (non-file) document, whose text is unrecoverable', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const builtin = addDoc('builtin:///Element.a');
      pass.run([builtin]);
      clock.advance(1_000_000);
      expect(cstNodeCount(builtin)).toBe(2);
   });

   it('keeps a document whose root has no recorded version resident, since its text could not be recorded', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const doc = addDoc('file:///unrecorded.a', false);
      pass.run([doc]);
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('keeps a document with an unresolved reference resident, cancelling a shed armed earlier', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } });
      const doc = addDoc('file:///unresolved.a');
      pass.run([doc]);
      asMutable(doc.references[0]).error = { message: 'unresolved' } as LinkingError;
      pass.run([doc]);
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('keeps a document resident that gained an unresolved reference in a build cancelled before the shed fired', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } });
      const doc = addDoc('file:///unresolved.a');
      pass.run([doc]);
      asMutable(doc.references[0]).error = { message: 'unresolved' } as LinkingError;
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('keeps a document resident that a build has taken below Validated when the shed fires', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } });
      const doc = addDoc('file:///rebuilding.a');
      pass.run([doc]);
      asMutable(doc).state = DocumentState.ComputedScopes;
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('keeps its own guards under an isSheddable override that admits every document', () => {
      class AdmitAll extends DefaultCstResidencyService {
         protected override isSheddable(): boolean {
            return true;
         }
      }
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } }, AdmitAll);
      const unrecorded = addDoc('file:///unrecorded.a', false);
      const rebuilding = addDoc('file:///rebuilding.a');
      pass.run([unrecorded, rebuilding]);
      asMutable(rebuilding).state = DocumentState.ComputedScopes;
      clock.advance(1_000_000);
      expect(cstNodeCount(unrecorded)).toBe(2);
      expect(cstNodeCount(rebuilding)).toBe(2);
   });

   it('does not parse a diverged document again for a graft, and keeps its re-parse of the same text resident', () => {
      const { service, pass, clock, ledger, addDoc, parses } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const doc = addDoc('file:///diverged.a');
      pass.run([doc]);
      clock.advance(0);
      expect(cstNodeCount(doc)).toBe(0);

      service.rehydrate(doc);
      service.rehydrate(doc);
      expect(parses()).toBe(1);

      // A build re-parses the same text into a new root.
      const reparsed = makeDocument('file:///diverged.a').parseResult.value;
      ledger.record(reparsed, 2);
      asMutable(doc.parseResult).value = reparsed;
      pass.run([doc]);
      clock.advance(0);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('sheds a diverged document again once its text changed', () => {
      const { service, pass, clock, ledger, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const doc = addDoc('file:///diverged.a');
      pass.run([doc]);
      clock.advance(0);
      service.rehydrate(doc);

      const edited = makeDocument('file:///diverged.a').parseResult.value;
      ledger.record(edited, 2, 'edited');
      asMutable(doc.parseResult).value = edited;
      pass.run([doc]);
      clock.advance(0);
      expect(cstNodeCount(doc)).toBe(0);
   });

   it('sheds only after the document has been idle for idleMs', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } });
      const doc = addDoc('file:///a.a');
      pass.run([doc]);
      clock.advance(999);
      expect(cstNodeCount(doc)).toBe(2);
      clock.advance(1);
      expect(cstNodeCount(doc)).toBe(0);
   });

   it('re-use (a later build) resets the idle window so a hot document stays resident', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } });
      const doc = addDoc('file:///a.a');
      pass.run([doc]); // window opens at t=0, fires at 1000
      clock.advance(600);
      pass.run([doc]); // re-used at t=600 → window resets, fires at 1600
      clock.advance(600); // t=1200: original deadline passed, but it was reset
      expect(cstNodeCount(doc)).toBe(2);
      clock.advance(400); // t=1600
      expect(cstNodeCount(doc)).toBe(0);
   });

   it('reopening before the idle window elapses cancels the pending shed', () => {
      const { pass, clock, open, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } });
      const doc = addDoc('file:///a.a');
      pass.run([doc]); // closed → armed
      open.add('file:///a.a');
      pass.run([doc]); // reopened → cancel
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('cancelPendingShed cancels armed shed timers', () => {
      const { service, pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 1000 } });
      const doc = addDoc('file:///a.a');
      pass.run([doc]);
      service.cancelPendingShed();
      clock.advance(1_000_000);
      expect(cstNodeCount(doc)).toBe(2);
   });

   it('traces the exact shed node count, with no byte estimate by default', () => {
      const { pass, clock, addDoc, traces } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      pass.run([addDoc('file:///a.a')]);
      clock.advance(1);
      const shedTrace = traces.find(message => message.startsWith('shed CST of file:///a.a'));
      expect(shedTrace).toBeDefined();
      expect(shedTrace).toContain('2 nodes');
      // Default estimatedBytesPerShedNode = 0 → no grammar-specific byte figure.
      expect(shedTrace).not.toContain('reclaimed est.');
   });

   it('appends an opt-in byte estimate to the shed trace when estimatedBytesPerShedNode is set', () => {
      const { pass, clock, addDoc, traces } = makeService({
         strategy: { kind: 'shed-closed-when-idle', idleMs: 0 },
         estimatedBytesPerShedNode: 1000
      });
      pass.run([addDoc('file:///a.a')]);
      clock.advance(1);
      const shedTrace = traces.find(message => message.startsWith('shed CST of file:///a.a'));
      // 2 nodes × 1000 bytes → ~2 KB.
      expect(shedTrace).toContain('reclaimed est.');
      expect(shedTrace).toMatch(/~.*B reclaimed est\./);
   });

   it('keeps the text a recorded root was parsed from once its CST is shed', () => {
      const { pass, clock, ledger, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const doc = addDoc('file:///a.a');
      const root = doc.parseResult.value;
      asMutable(root).$cstNode = { root: { fullText: 'name: a\n' } } as CstNode;
      ledger.record(root, 3);

      pass.run([doc]);
      clock.advance(1);

      expect({ shed: root.$cstNode, text: ledger.textOf(root), version: ledger.versionOf(root) }).toEqual({
         shed: undefined,
         text: 'name: a\n',
         version: 3
      });
   });
});

describe('CstResidencyService.rehydrateNode', () => {
   it('is a no-op for a resident node, never touching the document factory', () => {
      // The harness's noop services carry NO LangiumDocumentFactory: the fast
      // path must return before resolving it, or this test throws.
      const { service, addDoc } = makeService({ strategy: { kind: 'always-keep' } });
      const doc = addDoc('file:///resident.a');
      expect(() => service.rehydrateNode(doc.parseResult.value)).not.toThrow();
   });

   it('is a no-op for a node outside any document', () => {
      const { service } = makeService({ strategy: { kind: 'always-keep' } });
      expect(() => service.rehydrateNode({ $type: 'Element' })).not.toThrow();
   });
});

describe('CstResidencyService.rehydrate on grammar values', () => {
   /** Rehydrate a shed one-node document holding `value` in `at`, whose text parses to `freshValue`. */
   function rehydrateValue(value: unknown, freshValue: unknown): { root: Record<string, unknown>; freshCst: object } {
      const ledger = new DefaultModelLedger();
      const freshCst = { root: { fullText: 'root' } };
      const services = makeNoopSharedServices({
         AstReflection: makeFakeReflection({ Root: { at: {} } }),
         workspace: {
            TextDocuments: { isOpenInAnyClient: () => false },
            ModelLedger: ledger,
            LangiumDocumentFactory: {
               fromString: () => ({ parseResult: { value: { $type: 'Root', $cstNode: freshCst, at: freshValue } } })
            },
            BuildPhasePassService: { register: () => Disposable.EMPTY }
         }
      });
      const service = new DefaultCstResidencyService(services, { strategy: { kind: 'always-keep' } });
      const root: Record<string, unknown> = { $type: 'Root', at: value };
      const document = {
         uri: URI.parse('file:///values.a'),
         state: DocumentState.Validated,
         parseResult: { value: root },
         textDocument: { getText: () => 'root' },
         references: []
      } as unknown as LangiumDocument;
      ledger.record(document.parseResult.value, 1, 'root');
      service.rehydrate(document);
      return { root, freshCst };
   }

   it('grafts a document whose Date value its text parses to again', () => {
      const { root, freshCst } = rehydrateValue(new Date(0), new Date(0));
      expect(root.$cstNode).toBe(freshCst);
   });

   it('leaves a document shed whose Date value its text no longer parses to', () => {
      const { root } = rehydrateValue(new Date(0), new Date(1));
      expect(root.$cstNode).toBeUndefined();
   });

   it('grafts a document whose NaN value its text parses to again', () => {
      const { root, freshCst } = rehydrateValue(Number.NaN, Number.NaN);
      expect(root.$cstNode).toBe(freshCst);
   });

   it('grafts a document whose value is an object with no known equality', () => {
      const { root, freshCst } = rehydrateValue({ amount: 1 }, { amount: 2 });
      expect(root.$cstNode).toBe(freshCst);
   });
});

describe('isCstShed', () => {
   function doc(state: DocumentState, root: object | undefined): LangiumDocument {
      return { uri: URI.parse('file:///a.a'), state, parseResult: { value: root } } as unknown as LangiumDocument;
   }

   /** A ledger that recorded `root`'s text, as a shed does. */
   function shedLedger(root: AstNode): DefaultModelLedger {
      const ledger = new DefaultModelLedger();
      ledger.record(root, 1, 'text');
      return ledger;
   }

   it('is true for a built document whose CST was shed', () => {
      const root = { $type: 'Model' };
      expect(isCstShed(doc(DocumentState.Validated, root), shedLedger(root))).toBe(true);
   });

   it('is false when the CST is still present', () => {
      const root = makeFakeAstNode({ $type: 'Model', $cstNode: {} });
      expect(isCstShed(doc(DocumentState.Validated, root), shedLedger(root))).toBe(false);
   });

   it('is false for a document without a CST and with no text to graft one from', () => {
      expect(isCstShed(doc(DocumentState.Validated, { $type: 'Model' }), new DefaultModelLedger())).toBe(false);
   });

   it('is false for the unparsed INVALID placeholder (still at Changed)', () => {
      const root = { $type: 'INVALID' };
      expect(isCstShed(doc(DocumentState.Changed, root), shedLedger(root))).toBe(false);
   });

   it('CST_REHYDRATION_RESET_STATE forces a full re-parse (is below Parsed)', () => {
      expect(CST_REHYDRATION_RESET_STATE).toBe(DocumentState.Changed);
      expect(CST_REHYDRATION_RESET_STATE < DocumentState.Parsed).toBe(true);
   });
});
