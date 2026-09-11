/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { DocumentState, type LangiumDocument, URI } from '@hydranium/langium';
import { Disposable, type Tracer } from '@hydranium/protocol';
import { type FakeClock, makeFakeClock } from '@hydranium/protocol/testing';
import {
   CST_REHYDRATION_RESET_STATE,
   DefaultCstResidencyService,
   type CstResidencyOptions,
   isCstShed
} from '../../../src/langium/residency/cst-residency-service.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

/** A build-phase pass captured at registration time so the test can drive its `run`. */
interface CapturedPass {
   run(documents: readonly LangiumDocument[]): void;
}

/** Build a service over stub shared services; returns the captured pass, the fake clock, and mutable test knobs. */
function makeService(options: CstResidencyOptions): {
   service: DefaultCstResidencyService;
   pass: CapturedPass;
   open: Set<string>;
   clock: FakeClock;
   traces: string[];
   addDoc: (uriText: string) => LangiumDocument;
} {
   const open = new Set<string>();
   const docs = new Map<string, LangiumDocument>();
   const clock = makeFakeClock();
   let captured: CapturedPass | undefined;
   const traces: string[] = [];
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
         BuildPhasePassService: {
            register: (pass: CapturedPass) => {
               captured = pass;
               return Disposable.EMPTY;
            }
         }
      }
   });
   const service = new DefaultCstResidencyService(services, options);
   if (!captured) {
      throw new Error('CstResidencyService did not register a build-phase pass');
   }
   const addDoc = (uriText: string): LangiumDocument => {
      const document = makeDocument(uriText);
      docs.set(document.uri.toString(), document);
      return document;
   };
   return { service, pass: captured, open, clock, traces, addDoc };
}

/** A two-node AST document with CST attached to every node and one reference. */
function makeDocument(uriText: string): LangiumDocument {
   const child: Record<string, unknown> = { $type: 'Child', $cstNode: {} };
   const root: Record<string, unknown> = { $type: 'Root', $cstNode: {}, child };
   child.$container = root;
   return {
      uri: URI.parse(uriText),
      parseResult: { value: root },
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

   it('does not shed a synthetic (non-file) document — its text is unrecoverable', () => {
      const { pass, clock, addDoc } = makeService({ strategy: { kind: 'shed-closed-when-idle', idleMs: 0 } });
      const builtin = addDoc('builtin:///Element.a');
      pass.run([builtin]);
      clock.advance(1_000_000);
      expect(cstNodeCount(builtin)).toBe(2);
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
});

describe('CstResidencyService.rehydrateNode', () => {
   it('is a no-op for a resident node — the document factory is never touched', () => {
      // The harness's noop services carry NO LangiumDocumentFactory: the fast
      // path must return before resolving it, or this test throws.
      const { service, addDoc } = makeService({ strategy: { kind: 'always-keep' } });
      const doc = addDoc('file:///resident.a');
      expect(() => service.rehydrateNode(doc.parseResult.value)).not.toThrow();
   });
});

describe('isCstShed', () => {
   function doc(state: DocumentState, root: object | undefined): LangiumDocument {
      return { uri: URI.parse('file:///a.a'), state, parseResult: { value: root } } as unknown as LangiumDocument;
   }

   it('is true for a built document whose CST was shed', () => {
      expect(isCstShed(doc(DocumentState.Validated, { $type: 'Model' }))).toBe(true);
   });

   it('is false when the CST is still present', () => {
      expect(isCstShed(doc(DocumentState.Validated, { $type: 'Model', $cstNode: {} }))).toBe(false);
   });

   it('is false for the unparsed INVALID placeholder (still at Changed)', () => {
      expect(isCstShed(doc(DocumentState.Changed, { $type: 'INVALID' }))).toBe(false);
   });

   it('CST_REHYDRATION_RESET_STATE forces a full re-parse (is below Parsed)', () => {
      expect(CST_REHYDRATION_RESET_STATE).toBe(DocumentState.Changed);
      expect(CST_REHYDRATION_RESET_STATE < DocumentState.Parsed).toBe(true);
   });
});
