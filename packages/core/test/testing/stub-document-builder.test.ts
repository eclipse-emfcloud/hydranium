/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeStubDocumentBuilder` against the Langium `DocumentBuilder` it doubles.
 *
 * Six of the seven claimed members ride a `Pick<DocumentBuilder, …>` in shipped
 * source, so a Langium bump that moves their signatures fails `npm run build`.
 * `waitUntil` does not: it is hand-declared, because the real member is two
 * overloads and an object-literal method type can express only one. That is the
 * one signature nothing holds to the real type, so the conformance block binds
 * it explicitly and `typecheck:test` becomes the assertion.
 *
 * The stub makes no behavioural claim about the real builder — `update` records
 * and never parses — so the rest is the drive/observe contract its own doc
 * comments state: a gate whose consumption is observable, phase dispatch scoped
 * to one state, and loud failures for the three members it declares but does
 * not implement. Those claims are what a suite silently depends on, so they are
 * what is pinned.
 */

import { describe, expect, it } from 'vitest';
import { DocumentState, URI, type DocumentBuilder, type LangiumDocument } from '@hydranium/langium';
import { CancellationToken } from 'vscode-languageserver';
import { makeFakeAstNode, makeFakeDocument, makeStubDocumentBuilder, type StubDocumentBuilder } from '../../src/testing/index.js';

const URI_ONE = URI.parse('file:///a.x');
const URI_TWO = URI.parse('file:///b.x');

function document(uri: URI): LangiumDocument {
   return makeFakeDocument(uri, makeFakeAstNode({ $type: 'TypeOne' }));
}

describe('makeStubDocumentBuilder — signature conformance for the hand-declared waitUntil', () => {
   it('accepts no call the real member would reject', () => {
      // The assignment runs REAL → STUB, not the other way round. The real
      // member is an overload pair, and a single-signature function is
      // assignable to neither overload alone (the first takes a
      // `CancellationToken` where the second takes a `URI`), so binding the
      // stub to `DocumentBuilder['waitUntil']` cannot express the constraint.
      // This direction can: it holds only while some real overload still
      // accepts everything the stub's declared signature permits and answers a
      // compatible result — which is exactly what a test written against the
      // stub relies on when the same code runs against the real builder. The
      // cast manufactures a value of the real type; the ASSIGNMENT on the next
      // line is the assertion, and it is checked by `typecheck:test`, not at
      // runtime.
      const realTyped = null as unknown as DocumentBuilder['waitUntil'];
      const stubShaped: StubDocumentBuilder['waitUntil'] = realTyped;

      expect(stubShaped).toBeNull();
      expect(typeof makeStubDocumentBuilder().waitUntil).toBe('function');
   });
});

describe('makeStubDocumentBuilder — recording', () => {
   it('records update arguments by reference, in call order', async () => {
      const builder = makeStubDocumentBuilder();

      await builder.update([URI_ONE], []);
      await builder.update([], [URI_TWO]);

      expect(builder.updateCalls.map(call => call.args.map(list => list.map(uri => uri.toString())))).toEqual([
         [[URI_ONE.toString()], []],
         [[], [URI_TWO.toString()]]
      ]);
   });

   it('records the waitUntil state and URI, and answers the URI it was asked about', async () => {
      const builder = makeStubDocumentBuilder();

      await expect(builder.waitUntil(DocumentState.Validated, URI_ONE)).resolves.toBe(URI_ONE);
      await expect(builder.waitUntil(DocumentState.IndexedContent)).resolves.toBeUndefined();

      expect(builder.waitUntilCalls.map(call => [call.args[0], call.args[1]?.toString()])).toEqual([
         [DocumentState.Validated, URI_ONE.toString()],
         [DocumentState.IndexedContent, undefined]
      ]);
   });
});

describe('makeStubDocumentBuilder — the waitUntil gate', () => {
   it('holds the call until resolve, and reports consumption while it is held', async () => {
      const builder = makeStubDocumentBuilder();
      const gate = builder.gateNextWaitUntil();
      expect(gate.consumed).toBe(false);

      let settled = false;
      const held = builder.waitUntil(DocumentState.Validated, URI_ONE).then(() => (settled = true));

      // Sampled once the call has been recorded, which is the observable that
      // separates "held" from "never reached the wait" — a `settled === false`
      // read on its own is satisfied by both.
      expect(builder.waitUntilCalls).toHaveLength(1);
      expect(gate.consumed).toBe(true);
      expect(settled).toBe(false);

      gate.resolve();
      await held;
      expect(settled).toBe(true);
   });

   it('refuses a resolve that held nothing, and does not leave the gate queued for a later call', async () => {
      const builder = makeStubDocumentBuilder();
      const gate = builder.gateNextWaitUntil();

      expect(() => gate.resolve()).toThrow(/ran before any waitUntil took the gate/);

      // The throw has to also DEQUEUE: an unconsumed gate is FIFO-handed to the
      // next `waitUntil`, so a leftover would park an unrelated later call
      // forever and the failure would surface as a timeout somewhere else.
      await expect(builder.waitUntil(DocumentState.Validated, URI_ONE)).resolves.toBe(URI_ONE);
   });

   it('hands gates to waitUntil calls in FIFO order', async () => {
      const builder = makeStubDocumentBuilder();
      const first = builder.gateNextWaitUntil();
      const second = builder.gateNextWaitUntil();

      const order: string[] = [];
      const one = builder.waitUntil(DocumentState.Validated, URI_ONE).then(() => order.push('one'));
      const two = builder.waitUntil(DocumentState.Validated, URI_TWO).then(() => order.push('two'));

      second.resolve();
      await two;
      // Releasing the SECOND gate must release the SECOND call; a stub handing
      // gates out in reverse would let an ordering assertion pass by accident.
      expect(order).toEqual(['two']);
      first.resolve();
      await one;
      expect(order).toEqual(['two', 'one']);
   });

   it('lets an ungated waitUntil through without a gate being taken', async () => {
      const builder = makeStubDocumentBuilder();
      await expect(builder.waitUntil(DocumentState.Validated, URI_ONE)).resolves.toBe(URI_ONE);
   });
});

describe('makeStubDocumentBuilder — phase and update dispatch', () => {
   it('fires only the listeners registered for the state being fired', () => {
      const builder = makeStubDocumentBuilder();
      const validated: string[] = [];
      const indexed: string[] = [];
      builder.onDocumentPhase(DocumentState.Validated, doc => void validated.push(doc.uri.toString()));
      builder.onDocumentPhase(DocumentState.IndexedContent, doc => void indexed.push(doc.uri.toString()));

      builder.firePhase(DocumentState.Validated, document(URI_ONE));

      expect(validated).toEqual([URI_ONE.toString()]);
      // Per-state, like the real builder's phase registry — a stub that fanned
      // every fire to every state would make a "only my phase" assertion pass
      // for the wrong reason.
      expect(indexed).toEqual([]);
   });

   it('passes a non-cancelled token by default and the caller token when given', () => {
      const builder = makeStubDocumentBuilder();
      const cancelled: boolean[] = [];
      builder.onDocumentPhase(DocumentState.Validated, (_doc, token) => void cancelled.push(token.isCancellationRequested));

      builder.firePhase(DocumentState.Validated, document(URI_ONE));
      builder.firePhase(DocumentState.Validated, document(URI_ONE), CancellationToken.Cancelled);

      expect(cancelled).toEqual([false, true]);
   });

   it('stops firing a disposed phase listener while keeping its neighbours', () => {
      const builder = makeStubDocumentBuilder();
      const first: number[] = [];
      const second: number[] = [];
      const subscription = builder.onDocumentPhase(DocumentState.Validated, () => void first.push(1));
      builder.onDocumentPhase(DocumentState.Validated, () => void second.push(1));

      builder.firePhase(DocumentState.Validated, document(URI_ONE));
      subscription.dispose();
      builder.firePhase(DocumentState.Validated, document(URI_ONE));

      // The first arrival is asserted too: a listener wired to nothing also
      // produces an empty log after dispose.
      expect(first).toEqual([1]);
      expect(second).toEqual([1, 1]);
   });

   it('fans an onUpdate fire to every live subscriber and stops at dispose', () => {
      const builder = makeStubDocumentBuilder();
      const seen: string[][] = [];
      const subscription = builder.onUpdate((changed, deleted) => {
         seen.push([...changed.map(uri => uri.toString()), ...deleted.map(uri => `-${uri.toString()}`)]);
      });

      builder.fireOnUpdate([URI_ONE], [URI_TWO]);
      subscription.dispose();
      builder.fireOnUpdate([URI_ONE], []);

      expect(seen).toEqual([[URI_ONE.toString(), `-${URI_TWO.toString()}`]]);
   });
});

describe('makeStubDocumentBuilder — the members it declares but does not implement', () => {
   it('throws a named error rather than being undefined', () => {
      const builder = makeStubDocumentBuilder();

      // The stub claims these through the `Pick`, so a consumer reaching them
      // via the bind-site cast would otherwise fail with "undefined is not a
      // function", which names neither the stub nor the method.
      expect(() => builder.build([document(URI_ONE)])).toThrow(/StubDocumentBuilder\.build is not implemented/);
      expect(() => builder.onBuildPhase(DocumentState.Validated, async () => undefined)).toThrow(
         /StubDocumentBuilder\.onBuildPhase is not implemented/
      );
      expect(() => builder.resetToState(document(URI_ONE), DocumentState.Parsed)).toThrow(
         /StubDocumentBuilder\.resetToState is not implemented/
      );
   });
});

describe('makeStubDocumentBuilder — reset', () => {
   it('drops recorded calls, listeners and pending gates', async () => {
      const builder = makeStubDocumentBuilder();
      let phases = 0;
      let updates = 0;
      builder.onDocumentPhase(DocumentState.Validated, () => void (phases += 1));
      builder.onUpdate(() => void (updates += 1));
      builder.gateNextWaitUntil();
      await builder.update([URI_ONE], []);

      // Non-empty before, so the emptiness after is a statement about `reset`
      // rather than about a builder that recorded nothing.
      expect(builder.updateCalls).toHaveLength(1);

      builder.reset();
      builder.firePhase(DocumentState.Validated, document(URI_ONE));
      builder.fireOnUpdate([URI_ONE], []);

      expect(builder.updateCalls).toEqual([]);
      expect(builder.waitUntilCalls).toEqual([]);
      expect(phases).toBe(0);
      expect(updates).toBe(0);
      // The dropped gate is the load-bearing half: a surviving one would hold
      // the next test's first `waitUntil` and time it out.
      await expect(builder.waitUntil(DocumentState.Validated, URI_ONE)).resolves.toBe(URI_ONE);
   });
});
