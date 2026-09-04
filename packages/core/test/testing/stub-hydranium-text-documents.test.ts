/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeStubHydraniumTextDocuments` measured against the real
 * `HydraniumTextDocuments` where the stub claims to mirror it, and against the
 * real TYPE where it hand-declares a member.
 *
 * Two axes, because two different things can drift:
 *
 * - **Signatures.** The picked members are bound through
 *   `Pick<HydraniumTextDocuments, …>` in shipped source, so those already fail
 *   `npm run build` on a change. The four members the stub declares itself —
 *   `get`, `notifyDidSaveTextDocument`, `onDidSave`, `onDidClose` — carry no
 *   such tie, and two of the four are documented as deliberately narrower. The
 *   conformance block below binds exactly the ones that claim real shape, so a
 *   change to the real event payload fails `typecheck:test`.
 * - **Behaviour.** The stub states two rules as matching the real store: an
 *   authored write steps the shared version iff the text differs, and a close
 *   drops the client's hold BEFORE notifying so a listener reading
 *   `isOpenInAnyClient` sees the decremented state. Neither is visible to a
 *   compiler, and a suite exercising the stub alone would certify whatever the
 *   stub happens to do. Both are compared against the real store here.
 *
 * A differential passes vacuously if the real store never held the document, so
 * each differential asserts the real store's own answer explicitly first.
 */

import { describe, expect, it } from 'vitest';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { HydraniumTextDocuments, type ClientTextDocumentChangeEvent } from '../../src/documents/hydranium-text-documents.js';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { makeNoopSharedServices, makeStubHydraniumTextDocuments } from '../../src/testing/index.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

const URI_ONE = 'file:///a.x';
const URI_TWO = 'file:///b.x';
const AUTHORING_CLIENT = 'client-a';

/**
 * The real store, headless. It reads `Tracer` and the URI policy only; the LSP
 * connection is needed for the egress channel alone, which no assertion here
 * touches.
 */
function realStore(): HydraniumTextDocuments<TextDocument> {
   const services = makeNoopSharedServices<ServerSharedServices>({
      workspace: { DocumentUriPolicy: new DefaultDocumentUriPolicy() }
   });
   return new HydraniumTextDocuments<TextDocument>(services);
}

/** Open `uri` in the real store the way a client does, so a write has a baseline. */
function openInReal(store: HydraniumTextDocuments<TextDocument>, uri: string, text: string, clientId: string): void {
   store.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'x', version: 1, text } }, clientId);
}

describe('makeStubHydraniumTextDocuments — signature conformance for the hand-declared members', () => {
   it('keeps onDidClose real-shaped', () => {
      const stub = makeStubHydraniumTextDocuments();
      // `onDidClose` is documented as carrying the real event payload, unlike
      // `onDidSave` / `get` / `notifyDidSaveTextDocument`, which are declared
      // narrower on purpose. This binding is the only thing holding it there:
      // a change to `ClientTextDocumentChangeEvent` reddens `typecheck:test`.
      const listener: (event: ClientTextDocumentChangeEvent<TextDocument>) => void = event => {
         expect(event.clientId).toBe(AUTHORING_CLIENT);
         expect(event.document.uri).toBe(URI_ONE);
      };
      stub.seedOpen(URI_ONE, 'one', AUTHORING_CLIENT);
      stub.onDidClose(listener);
      stub.fireClose(URI_ONE, AUTHORING_CLIENT);
   });
});

describe('makeStubHydraniumTextDocuments — differential against HydraniumTextDocuments', () => {
   it('steps the shared version on an authored write iff the text changed', () => {
      const real = realStore();
      const stub = makeStubHydraniumTextDocuments();
      openInReal(real, URI_ONE, 'one', AUTHORING_CLIENT);
      stub.seedOpen(URI_ONE, 'one', AUTHORING_CLIENT);

      const realBase = real.version(URI_ONE);
      const stubBase = stub.version(URI_ONE);
      // The real store seeds its sequence from the client's declared id and the
      // stub seeds at 1, so the DELTAS are what is comparable, not the absolute
      // versions. Assert the base is a real open first: a store that never held
      // the document answers 0 and every delta below would be 0 too.
      expect(realBase).toBeGreaterThan(0);
      expect(stubBase).toBeGreaterThan(0);

      const realChanged = real.applyContentChange(URI_ONE, 'two', AUTHORING_CLIENT);
      const stubChanged = stub.applyContentChange(URI_ONE, 'two', AUTHORING_CLIENT);
      expect(realChanged - realBase).toBe(1);
      expect(stubChanged - stubBase).toBe(1);

      const realIdentical = real.applyContentChange(URI_ONE, 'two', AUTHORING_CLIENT);
      const stubIdentical = stub.applyContentChange(URI_ONE, 'two', AUTHORING_CLIENT);
      expect(realIdentical).toBe(realChanged);
      expect(stubIdentical).toBe(stubChanged);
   });

   it('throws on an authored write to a document no client has open', () => {
      const real = realStore();
      const stub = makeStubHydraniumTextDocuments();
      expect(() => real.applyContentChange(URI_ONE, 'one', AUTHORING_CLIENT)).toThrow(/not open for content changes/);
      expect(() => stub.applyContentChange(URI_ONE, 'one', AUTHORING_CLIENT)).toThrow(/not open for content changes/);
   });

   it('records the authoring client of the current version', () => {
      const real = realStore();
      const stub = makeStubHydraniumTextDocuments();
      openInReal(real, URI_ONE, 'one', LANGUAGE_CLIENT_ID);
      stub.seedOpen(URI_ONE, 'one', LANGUAGE_CLIENT_ID);

      real.applyContentChange(URI_ONE, 'two', AUTHORING_CLIENT);
      stub.applyContentChange(URI_ONE, 'two', AUTHORING_CLIENT);

      expect(real.getAuthor(URI_ONE)).toBe(AUTHORING_CLIENT);
      expect(stub.getAuthor(URI_ONE)).toBe(AUTHORING_CLIENT);
      expect(real.getAuthor(URI_TWO)).toBeUndefined();
      expect(stub.getAuthor(URI_TWO)).toBeUndefined();
   });

   it('has already dropped the closing client by the time onDidClose runs', () => {
      const real = realStore();
      const stub = makeStubHydraniumTextDocuments();
      openInReal(real, URI_ONE, 'one', LANGUAGE_CLIENT_ID);
      stub.seedOpen(URI_ONE, 'one', LANGUAGE_CLIENT_ID);
      stub.seedOpenInLanguageClient(URI_ONE);

      // The last-close transition is detected by listeners consulting
      // `isOpenInAnyClient` from inside the close event; a store that dropped
      // the hold AFTER firing would answer `true` here and every downstream
      // "last client left" branch would be dead.
      const realDuring: boolean[] = [];
      const stubDuring: boolean[] = [];
      real.onDidClose(() => realDuring.push(real.isOpenInAnyClient(URI_ONE)));
      stub.onDidClose(() => stubDuring.push(stub.isOpenInAnyClient(URI_ONE)));

      real.notifyDidCloseTextDocument({ textDocument: { uri: URI_ONE } }, LANGUAGE_CLIENT_ID);
      stub.fireClose(URI_ONE, LANGUAGE_CLIENT_ID);

      expect(realDuring).toEqual([false]);
      expect(stubDuring).toEqual([false]);
      expect(real.isOpenInAnyClient(URI_ONE)).toBe(false);
      expect(stub.isOpenInAnyClient(URI_ONE)).toBe(false);
   });

   it('reports the open set per client, merging both of the stub seeding channels', () => {
      const real = realStore();
      const stub = makeStubHydraniumTextDocuments();
      openInReal(real, URI_ONE, 'one', LANGUAGE_CLIENT_ID);
      openInReal(real, URI_ONE, 'one', AUTHORING_CLIENT);
      stub.seedOpen(URI_ONE, 'one', AUTHORING_CLIENT);
      stub.seedOpenInLanguageClient(URI_ONE);

      const sortedClients = (entries: ReadonlyArray<{ uri: string; clients: readonly string[] }>): string[][] =>
         entries.map(entry => [...entry.clients].sort());
      expect(sortedClients(real.openDocuments())).toEqual([[AUTHORING_CLIENT, LANGUAGE_CLIENT_ID]]);
      expect(sortedClients(stub.openDocuments())).toEqual([[AUTHORING_CLIENT, LANGUAGE_CLIENT_ID]]);
      expect(real.isOpenInLanguageClient(URI_ONE)).toBe(true);
      expect(stub.isOpenInLanguageClient(URI_ONE)).toBe(true);
      // `seedOpen` alone is a non-LSP holder, so the LSP probe must stay false
      // — otherwise a test could not model a document held only by a form editor.
      const held = makeStubHydraniumTextDocuments();
      held.seedOpen(URI_TWO, 'two', AUTHORING_CLIENT);
      expect(held.isOpenInLanguageClient(URI_TWO)).toBe(false);
      expect(held.isOpenInAnyClient(URI_TWO)).toBe(true);
   });
});

describe('makeStubHydraniumTextDocuments — the wire-path supersession rule', () => {
   it('drops a wire change whose version does not advance, and records the one that does', () => {
      const stub = makeStubHydraniumTextDocuments();
      stub.seedOpen(URI_ONE, 'one', LANGUAGE_CLIENT_ID);

      stub.notifyDidChangeTextDocument({ textDocument: { uri: URI_ONE, version: 1 }, contentChanges: [{ text: 'stale' }] });
      expect(stub.get(URI_ONE)?.getText()).toBe('one');
      expect(stub.changes).toEqual([]);

      stub.notifyDidChangeTextDocument({ textDocument: { uri: URI_ONE, version: 2 }, contentChanges: [{ text: 'fresh' }] });
      expect(stub.get(URI_ONE)?.getText()).toBe('fresh');
      expect(stub.version(URI_ONE)).toBe(2);
      // The recorded entry is what a concurrent-update suite asserts on, so an
      // empty replay and a dropped payload have to be distinguishable.
      expect(stub.changes).toEqual([{ uri: URI_ONE, version: 2, text: 'fresh', clientId: LANGUAGE_CLIENT_ID }]);
   });

   it('attributes a wire change to the caller-named client, defaulting to the language client', () => {
      const stub = makeStubHydraniumTextDocuments();
      stub.notifyDidChangeTextDocument({ textDocument: { uri: URI_ONE, version: 3 }, contentChanges: [{ text: 'a' }] });
      stub.notifyDidChangeTextDocument({ textDocument: { uri: URI_TWO, version: 3 }, contentChanges: [{ text: 'b' }] }, AUTHORING_CLIENT);

      expect(stub.getAuthor(URI_ONE)).toBe(LANGUAGE_CLIENT_ID);
      expect(stub.getAuthor(URI_TWO)).toBe(AUTHORING_CLIENT);
   });

   it('records an identical authored write as a change while holding the version and the original author', () => {
      const stub = makeStubHydraniumTextDocuments();
      stub.seedOpen(URI_ONE, 'one', LANGUAGE_CLIENT_ID);

      const version = stub.applyContentChange(URI_ONE, 'one', AUTHORING_CLIENT);

      expect(version).toBe(1);
      expect(stub.getAuthor(URI_ONE)).toBe(LANGUAGE_CLIENT_ID);
      // The rebuild still fires on a content-identical authored write, so the
      // replay has to carry the call even though nothing about the doc moved.
      expect(stub.changes).toHaveLength(1);
   });
});

describe('makeStubHydraniumTextDocuments — the push channel to the language client', () => {
   it('records every push and answers accepted by default', async () => {
      const stub = makeStubHydraniumTextDocuments();

      const result = await stub.applyEditToLanguageClient(URI_ONE, 'pushed', { label: 'a label' });

      expect(result).toEqual({ applied: true });
      expect(stub.appliedEdits).toEqual([{ uri: URI_ONE, text: 'pushed', label: 'a label' }]);
   });

   it('routes the rejection path through the handler, recording the call either way', async () => {
      const stub = makeStubHydraniumTextDocuments();
      const seenInside: number[] = [];
      stub.setApplyEditHandler(() => {
         // The handler runs INSIDE the call, which is the only place a suite can
         // observe the in-flight state; if it ran after, a test could not model a
         // concurrent settle arriving mid-push.
         seenInside.push(stub.appliedEdits.length);
         return { applied: false };
      });

      const result = await stub.applyEditToLanguageClient(URI_ONE, 'pushed');

      expect(result).toEqual({ applied: false });
      expect(seenInside).toEqual([1]);
      expect(stub.appliedEdits).toHaveLength(1);
   });

   it('records staged content separately from pushed content', () => {
      const stub = makeStubHydraniumTextDocuments();
      stub.stagePendingContent(URI_ONE, 'staged');

      expect(stub.staged).toEqual([{ uri: URI_ONE, text: 'staged' }]);
      expect(stub.appliedEdits).toEqual([]);
   });
});

describe('makeStubHydraniumTextDocuments — save and reset', () => {
   it('delivers a save to live listeners, records it, and stops at dispose', () => {
      const stub = makeStubHydraniumTextDocuments();
      const seen: string[] = [];
      const subscription = stub.onDidSave(event => seen.push(`${event.document.uri}:${event.clientId}`));

      stub.notifyDidSaveTextDocument({ textDocument: { uri: URI_ONE } }, AUTHORING_CLIENT);
      subscription.dispose();
      stub.notifyDidSaveTextDocument({ textDocument: { uri: URI_TWO } }, AUTHORING_CLIENT);

      // Asserting the first arrival too: a listener wired to nothing also leaves
      // an empty log after dispose.
      expect(seen).toEqual([`${URI_ONE}:${AUTHORING_CLIENT}`]);
      expect(stub.saves).toEqual([
         { uri: URI_ONE, clientId: AUTHORING_CLIENT },
         { uri: URI_TWO, clientId: AUTHORING_CLIENT }
      ]);
   });

   it('drops every recorded axis, both open channels, the listeners and the edit handler on reset', async () => {
      const stub = makeStubHydraniumTextDocuments();
      let closes = 0;
      stub.seedOpen(URI_ONE, 'one', AUTHORING_CLIENT);
      stub.seedOpenInLanguageClient(URI_TWO);
      stub.onDidClose(() => (closes += 1));
      stub.onDidSave(() => (closes += 1));
      stub.setApplyEditHandler(() => ({ applied: false }));
      stub.applyContentChange(URI_ONE, 'two', AUTHORING_CLIENT);
      stub.stagePendingContent(URI_ONE, 'staged');
      await stub.applyEditToLanguageClient(URI_ONE, 'pushed');
      stub.notifyDidSaveTextDocument({ textDocument: { uri: URI_ONE } }, AUTHORING_CLIENT);

      // Non-empty before, so the emptiness after is a statement about `reset`
      // rather than about a stub that never recorded anything.
      expect(stub.changes.length).toBeGreaterThan(0);
      expect(closes).toBe(1);

      stub.reset();
      stub.fireClose(URI_ONE, AUTHORING_CLIENT);
      stub.notifyDidSaveTextDocument({ textDocument: { uri: URI_ONE } }, AUTHORING_CLIENT);

      expect(stub.changes).toEqual([]);
      expect(stub.saves).toEqual([{ uri: URI_ONE, clientId: AUTHORING_CLIENT }]);
      expect(stub.appliedEdits).toEqual([]);
      expect(stub.staged).toEqual([]);
      expect(stub.get(URI_ONE)).toBeUndefined();
      expect(stub.isOpenInAnyClient(URI_ONE)).toBe(false);
      expect(stub.isOpenInLanguageClient(URI_TWO)).toBe(false);
      expect(closes).toBe(1);
      expect(await stub.applyEditToLanguageClient(URI_ONE, 'pushed')).toEqual({ applied: true });
   });
});
