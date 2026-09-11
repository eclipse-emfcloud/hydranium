/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
   type CanonicalUri,
   createRpcProxy,
   Disposable,
   LatencyCollector,
   ReferenceSource,
   resolvedFromResponseError,
   type ReferenceCandidate,
   type ReferenceContext,
   type TransferDiagnostic
} from '@hydranium/protocol';
import type { ResponseError } from 'vscode-jsonrpc';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerDiagnosticsProtocol,
   type DataServerProtocol
} from '@hydranium/protocol/data';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { makeDuplexConnectionPair } from '@hydranium/protocol/testing/node';
import {
   IntegrityService,
   REVERT_ON_CLOSE_CLIENT_ID,
   type DocumentUriPolicy,
   type HydraniumLanguageServices,
   type ServerLanguageServices,
   type ServerSharedServices
} from '@hydranium/core';
import {
   makeFakeAstNode,
   makeStubServiceRegistry,
   makeTestServices,
   type StubLanguageDescriptor,
   type TestServicesBundle
} from '@hydranium/core/testing';
import { DefaultMessageRenderer } from '@hydranium/core/messages';
import { ProfileCapture } from '@hydranium/core/node';
import { DocumentState, type LangiumDocument, URI, UriUtils } from '@hydranium/langium';
import { DataServer, NO_ACTIVE_PROFILE, NO_ACTIVE_PROFILE_CODE } from '../src/data-server.js';
import { defaultDataServerDiagnostics as browserDefaultDiagnostics } from '../src/default-diagnostics.browser.js';
import { nodeDataServerDiagnostics } from '../src/node/node-diagnostics-provider.js';
import { type DataServerHarness, makeDataServerHarness } from '../src/testing/data-server-harness.js';

// ============================================================
// Fake AST + diagnostic types — keep tests grammar-free.
// ============================================================

interface FakeRoot {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

/**
 * Test diagnostic shape — we use the framework's `TransferDiagnostic` directly
 * so the encoder's default projection (LSP diagnostic → TransferDiagnostic)
 * satisfies the type constraint without a custom encoder. Tests only
 * assert on diagnostic-array LENGTH, not contents.
 */
type FakeDiagnostic = TransferDiagnostic;

// ============================================================
// Stub bundle — the framework testing subpath composes the
// Langium-layer stubs. The local helper just selects the
// FakeRoot-aware serialiser and exposes the bundle with the
// concrete generic params for this test suite.
// ============================================================

type Bundle = TestServicesBundle<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>;

function buildBundle(): Bundle {
   return makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
      serialize: (_uri, root) => `name:${root.name}`
   });
}

class TestDataServer extends DataServer<FakeRoot, FakeDiagnostic> {}

/**
 * Adds one method that rejects with a plain `Error`, so the rendering boundary
 * can be probed with a rejection carrying no identity. An `additionalMethods`
 * entry rather than an existing internal path, so which layer throws what is
 * not part of what the test depends on.
 */
class PlainFailureServer extends TestDataServer {
   async failPlain(): Promise<never> {
      throw new Error('a developer-facing failure');
   }
}

type TestHarness = DataServerHarness<TestDataServer, FakeRoot, FakeDiagnostic>;

/**
 * Wire a DataServer to one side of a duplex MessageConnection pair; the
 * client side gets a typed proxy with a local DataClientProtocol that
 * captures inbound events. The framework's {@link makeDataServerHarness}
 * provides the wiring; this helper just supplies the
 * grammar-specific server constructor.
 */
function makeHarness(services: ServerSharedServices): TestHarness {
   return makeDataServerHarness<TestDataServer, FakeRoot, FakeDiagnostic>({
      // The suite runs in Node and exercises the diagnostics methods, so it
      // supplies the same provider a Node host does. Constructing without one is
      // the browser configuration, covered separately below.
      server: channel => new TestDataServer(channel, services, { diagnostics: nodeDataServerDiagnostics() })
   });
}

const URI_A = 'file:///workspace/A.fake';
const URI_B = 'file:///workspace/B.fake';

/**
 * Simulate a rebuild reaching Validated. A real Langium rebuild passes through
 * `Linked` — where the encoder's per-document transfer-root cache evicts — before
 * `Validated`, where the DataServer dispatches the phase event. Firing `Validated`
 * alone would leave a stale cached root, so tests that change content between
 * emissions drive both phases. The optional cancel token applies to the
 * `Validated` dispatch only (the `Linked` eviction is unconditional).
 */
function fireRebuild(bundle: Bundle, document: LangiumDocument, cancelToken?: Parameters<Bundle['documentBuilder']['firePhase']>[2]): void {
   bundle.documentBuilder.firePhase(DocumentState.Linked, document);
   bundle.documentBuilder.firePhase(DocumentState.Validated, document, cancelToken);
}

describe('DataServer', () => {
   describe('getModelDocument', () => {
      it('returns the current document state at the integrity-settled landmark by default', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'current' });
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            const result = await proxy.getModelDocument({ uri: URI_A });

            expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
            expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(IntegrityService.SettledState);
            expect(bundle.documentBuilder.waitUntilCalls[0].args[1]?.toString()).toBe(URI.parse(URI_A).toString());
            // Warm document: smart dispatch waits, does not force a rebuild.
            expect(bundle.documentBuilder.updateCalls).toHaveLength(0);
            expect(result.uri).toBe(URI_A);
            expect(result.root?.name).toBe('current');
            expect(result.diagnostics).toEqual([]);
         } finally {
            pair.dispose();
         }
      });

      it('settles at Validated when includeDiagnostics is requested', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'current' });
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            await proxy.getModelDocument({ uri: URI_A, includeDiagnostics: true });
            expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
            expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(DocumentState.Validated);
         } finally {
            pair.dispose();
         }
      });

      it('rebuilds a cold document not yet in the registry', async () => {
         const bundle = buildBundle();
         // URI_A intentionally NOT seeded → cold path forces a build before
         // the wait. Gate the wait so we can observe the build, then seed
         // the document as the build would and release.
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            const gate = bundle.documentBuilder.gateNextWaitUntil();
            const pending = proxy.getModelDocument({ uri: URI_A });
            await waitFor(() => bundle.documentBuilder.updateCalls.length === 1);

            expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
            expect(bundle.documentBuilder.updateCalls[0].args[0].map(uri => uri.toString())).toEqual([URI.parse(URI_A).toString()]);

            bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'built' });
            gate.resolve();
            const result = await pending;

            expect(result.root?.name).toBe('built');
            expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
            expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(IntegrityService.SettledState);
         } finally {
            pair.dispose();
         }
      });

      it('waits for an in-flight build rather than returning stale state', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'stale' });
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            const gate = bundle.documentBuilder.gateNextWaitUntil();
            let resolved = false;
            const pending = proxy.getModelDocument({ uri: URI_A }).then(() => {
               resolved = true;
            });
            // Wait until the call is parked at the gated waitUntil, then assert it
            // cannot have resolved (it is blocked on the gate) — non-racy.
            await waitFor(() => bundle.documentBuilder.waitUntilCalls.length === 1);
            expect(resolved).toBe(false);

            bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'fresh' });
            gate.resolve();
            await pending;
            expect(resolved).toBe(true);
         } finally {
            pair.dispose();
         }
         // Generous timeout: under parallel CI/turbo CPU oversubscription the
         // event loop can be starved past Vitest's 5s default, well beyond what
         // an in-process RPC round-trip costs. Headroom, not a weaker assertion.
      }, 30_000);
   });

   describe('updateModelDocument', () => {
      it('applies a structured payload and the next getModelDocument reflects it', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'initial' });
         bundle.textDocuments.seedOpen(URI_A, 'name:initial', 'editor-1');
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            await proxy.updateModelDocument({
               uri: URI_A,
               clientId: 'editor-1',
               model: { $type: 'FakeRoot', name: 'updated' }
            });
            // Simulate the post-update document by updating the test registry.
            bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'updated' });

            const result = await proxy.getModelDocument({ uri: URI_A });
            expect(bundle.textDocuments.changes[0]?.text).toBe('name:updated');
            expect(result.root?.name).toBe('updated');
         } finally {
            pair.dispose();
         }
      });

      it('accepts a serialised-string payload — parseModel handles deserialisation', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'initial' });
         bundle.textDocuments.seedOpen(URI_A, 'name:initial', 'editor-1');
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            await proxy.updateModelDocument({
               uri: URI_A,
               clientId: 'editor-1',
               model: 'name:from-string'
            });
            expect(bundle.textDocuments.changes[0]?.text).toBe('name:from-string');
         } finally {
            pair.dispose();
         }
      });

      it('propagates the clientId to authorship via HydraniumTextDocuments', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'initial' });
         bundle.textDocuments.seedOpen(URI_A, 'name:initial', 'editor-1');
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            await proxy.updateModelDocument({
               uri: URI_A,
               clientId: 'data-server-tools',
               model: { $type: 'FakeRoot', name: 'attributed' }
            });
            expect(bundle.textDocuments.getAuthor(URI_A)).toBe('data-server-tools');
         } finally {
            pair.dispose();
         }
      });
   });

   describe('saveModelDocument', () => {
      it('writes via the framework WritableFileSystemProvider and registers the mtime with SelfSaveRegistry', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'initial' });
         bundle.textDocuments.seedOpen(URI_A, 'name:initial', 'editor-1');
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            await proxy.saveModelDocument({
               uri: URI_A,
               clientId: 'editor-1',
               model: { $type: 'FakeRoot', name: 'persisted' }
            });
            expect(bundle.fileSystem.writes).toHaveLength(1);
            expect(bundle.fileSystem.writes[0]?.content).toBe('name:persisted');
            expect(bundle.selfSaveRegistry.registerCalls).toHaveLength(1);
         } finally {
            pair.dispose();
         }
      });

      it('fires onDocumentSaved on the local client when a subscriber exists for the URI', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'initial' });
         bundle.textDocuments.seedOpen(URI_A, 'name:initial', 'editor-1');

         const savedEvents: { uri: string; sourceClientId: string }[] = [];
         const localClient: DataClientProtocol<FakeRoot, FakeDiagnostic> = {
            onDocumentUpdated(): void {
               // not exercised by this test
            },
            onDocumentSaved(event): void {
               savedEvents.push({ uri: event.document.uri, sourceClientId: event.sourceClientId });
            },
            onProjectsChanged(): void {
               // not exercised
            }
         };
         const pair = makeDuplexConnectionPair();
         new TestDataServer(pair.left, bundle.services);
         const proxy = createRpcProxy<DataServerProtocol<FakeRoot, FakeDiagnostic>, DataClientProtocol<FakeRoot, FakeDiagnostic>>(
            pair.right,
            {
               methodNamespace: DATA_SERVER_WIRE_PREFIX,
               localTarget: localClient,
               localMethods: DATA_CLIENT_PROTOCOL_METHODS
            }
         );
         try {
            // Without a subscription, the save fires no onDocumentSaved event (per-URI gate).
            await proxy.saveModelDocument({
               uri: URI_A,
               clientId: 'editor-1',
               model: { $type: 'FakeRoot', name: 'one' }
            });
            await tick(); // give a (wrongly) fired save event a chance, then assert none arrived
            expect(savedEvents).toHaveLength(0);

            // After subscribing, saves fire the event.
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            await proxy.saveModelDocument({
               uri: URI_A,
               clientId: 'editor-2',
               model: { $type: 'FakeRoot', name: 'two' }
            });
            await waitFor(() => savedEvents.length === 1);
            expect(savedEvents).toEqual([{ uri: URI_A, sourceClientId: 'editor-2' }]);
         } finally {
            pair.dispose();
         }
      });

      it('fires onDocumentSaved for a SYMLINKED file (save event arrives under the client URI S, subscription keyed at the canonical R)', async () => {
         // With a realpath-style canonicalizer, a symlinked file opened/saved under
         // path S has canonical identity R. `watchModelDocument` keys the subscription
         // at canonicalize(S)=R (and `dispatchPhaseEvent` checks document.uri=R), but
         // the text store fires its save event under S. `dispatchSaveEvent` must
         // canonicalize that S→R before the subscription check + envelope, or the
         // `onDocumentSaved` notification is silently dropped for symlinked files.
         const REAL = 'file:///real/x.fake';
         const LINK = 'file:///link/x.fake';
         const toText = (uri: string | URI): string => (typeof uri === 'string' ? uri : uri.toString());
         const linkAware: DocumentUriPolicy = {
            canonicalUri: uri => UriUtils.normalize(toText(uri) === LINK ? REAL : toText(uri)) as CanonicalUri,
            loadUri: uri => UriUtils.toUri(toText(uri) === LINK ? REAL : toText(uri))
         };
         const bundle = makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
            serialize: (_uri, root) => `name:${root.name}`,
            documentUriPolicy: linkAware
         });
         bundle.documents.set(REAL, { $type: 'FakeRoot', name: 'initial' });
         bundle.textDocuments.seedOpen(LINK, 'name:initial', 'editor-1');

         const savedEvents: { uri: string; sourceClientId: string }[] = [];
         const localClient: DataClientProtocol<FakeRoot, FakeDiagnostic> = {
            onDocumentUpdated(): void {
               /* not exercised */
            },
            onDocumentSaved(event): void {
               savedEvents.push({ uri: event.document.uri, sourceClientId: event.sourceClientId });
            },
            onProjectsChanged(): void {
               /* not exercised */
            }
         };
         const pair = makeDuplexConnectionPair();
         new TestDataServer(pair.left, bundle.services);
         const proxy = createRpcProxy<DataServerProtocol<FakeRoot, FakeDiagnostic>, DataClientProtocol<FakeRoot, FakeDiagnostic>>(
            pair.right,
            {
               methodNamespace: DATA_SERVER_WIRE_PREFIX,
               localTarget: localClient,
               localMethods: DATA_CLIENT_PROTOCOL_METHODS
            }
         );
         try {
            await proxy.watchModelDocument({ uri: LINK, clientId: 'sub-1' });
            await proxy.saveModelDocument({ uri: LINK, clientId: 'editor-2', model: { $type: 'FakeRoot', name: 'two' } });
            await waitFor(() => savedEvents.length === 1);
            expect(savedEvents[0]?.sourceClientId).toBe('editor-2');
            // Envelope resolved against the canonical doc (non-empty content).
            expect(savedEvents[0]?.uri).toBe(UriUtils.normalize(REAL));
         } finally {
            pair.dispose();
         }
      });
   });

   describe('watchModelDocument', () => {
      it('delivers onDocumentUpdated to the local client when a phase listener fires for a subscribed URI', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'initial' });
         bundle.textDocuments.seedOpen(URI_A, 'name:initial', 'editor-1');
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            // Simulate a content change followed by phase completion. The emission
            // fingerprint dedup in `dispatchPhaseEvent` requires content to differ
            // from the subscribe-time baseline for an event to fire.
            const changed = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'changed' });
            fireRebuild(bundle, changed);
            await waitFor(() => events.length === 1);

            expect(events[0]?.document.uri).toBe(URI_A);
            expect(events[0]?.sourceClientId).toBe('editor-1');
         } finally {
            pair.dispose();
         }
      });

      it('filters per-URI: subscribers for one URI do not see other URIs', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const docB = bundle.documents.set(URI_B, { $type: 'FakeRoot', name: 'B' });
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });

            fireRebuild(bundle, docB);
            await tick(); // give a (wrongly) fired event a chance, then assert none arrived
            expect(events).toHaveLength(0);

            const changedA = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-changed' });
            fireRebuild(bundle, changedA);
            await waitFor(() => events.length === 1);
            expect(events).toHaveLength(1);
         } finally {
            pair.dispose();
         }
      });

      it('unwatchModelDocument stops further events for that subscriber', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            const changed = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-changed' });
            fireRebuild(bundle, changed);
            await waitFor(() => events.length === 1);
            expect(events).toHaveLength(1);

            await proxy.unwatchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            const changedAgain = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-changed-again' });
            fireRebuild(bundle, changedAgain);
            await tick(); // give a (wrongly) re-fired event a chance, then assert none arrived
            expect(events).toHaveLength(1);
         } finally {
            pair.dispose();
         }
      });

      it('closeModelDocument releases the watch for that (uri, clientId)', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const { server, proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            const internal = server as unknown as { subscriptions: Map<string, unknown> };
            expect(internal.subscriptions.size).toBe(1);

            // Closing the session also drops the watch — no explicit unwatch needed.
            await proxy.closeModelDocument({ uri: URI_A, clientId: 'sub-1' });
            expect(internal.subscriptions.size).toBe(0);

            const changed = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-changed' });
            bundle.documentBuilder.firePhase(DocumentState.Validated, changed);
            await tick(); // a (wrongly) re-fired event would arrive here
            expect(events).toHaveLength(0);
         } finally {
            pair.dispose();
         }
      });

      it('closes a dead client’s open documents on teardown', async () => {
         // The hazard exists only for a client that dies WITHOUT closing, so this
         // never calls closeModelDocument. Teardown is driven through `dispose()`
         // rather than by destroying the transport: `dispose()` is what the
         // `connection.onClose` handler calls, and that wiring has its own test
         // below — a MessageConnection's own `dispose()` fires the dispose emitter
         // and not the close one, so disposing the pair would not reach it.
         //
         // The observable is the store's per-URI open-client set, one layer below
         // the `isOpenInAnyClient` the residency and revert decisions read.
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const { server, proxy, pair } = makeHarness(bundle.services);
         try {
            await proxy.openModelDocument({ uri: URI_A, clientId: 'doomed' });
            // Open BEFORE the teardown, or "not open after" is satisfied by it
            // never having been open at all.
            expect([...(bundle.astDocumentManager.openClients.get(URI_A) ?? [])]).toEqual(['doomed']);

            server.dispose();
            await tick();

            expect([...(bundle.astDocumentManager.openClients.get(URI_A) ?? [])]).toEqual([]);
         } finally {
            pair.dispose();
         }
      });

      it('drains only the holds still outstanding, not every URI it ever opened', async () => {
         // Pairs with the drain above, which a teardown that blindly closed every
         // URI it had seen would also satisfy. A graceful close has to remove the
         // record, or the drain fires a second close for a document another client
         // may by then legitimately hold.
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const { server, proxy, pair } = makeHarness(bundle.services);
         try {
            await proxy.openModelDocument({ uri: URI_A, clientId: 'polite' });
            await proxy.closeModelDocument({ uri: URI_A, clientId: 'polite' });
            const internal = server as unknown as { openedDocuments: Map<string, Set<string>> };
            expect(internal.openedDocuments.size).toBe(0);

            server.dispose();
            await tick();

            expect([...(bundle.astDocumentManager.openClients.get(URI_A) ?? [])]).toEqual([]);
         } finally {
            pair.dispose();
         }
      });

      it('discriminates reason: changed/deleted/rebuilt based on the last documentBuilder.onUpdate snapshot', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });

            // Each phase event needs distinct document content; otherwise the emission
            // fingerprint dedup in `dispatchPhaseEvent` suppresses redundant emissions.

            // `changed` list contains URI_A → reason should be 'changed'.
            const docChanged = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-v2' });
            bundle.documentBuilder.fireOnUpdate([URI.parse(URI_A)], []);
            fireRebuild(bundle, docChanged);
            await waitFor(() => events.length >= 1);
            expect(events[events.length - 1].reason).toBe('changed');

            // `deleted` list contains URI_A → reason should be 'deleted'.
            const docDeleted = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-v3' });
            bundle.documentBuilder.fireOnUpdate([], [URI.parse(URI_A)]);
            fireRebuild(bundle, docDeleted);
            await waitFor(() => events.length >= 2);
            expect(events[events.length - 1].reason).toBe('deleted');

            // URI not in either list (cascade rebuild from a dependent) → 'rebuilt' fallback.
            const docRebuilt = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-v4' });
            bundle.documentBuilder.fireOnUpdate([URI.parse(URI_B)], []);
            fireRebuild(bundle, docRebuilt);
            await waitFor(() => events.length >= 3);
            expect(events[events.length - 1].reason).toBe('rebuilt');
         } finally {
            pair.dispose();
         }
      });

      it('suppresses redundant onDocumentUpdated when text and diagnostics are unchanged since last emit', async () => {
         const bundle = buildBundle();
         const doc = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'stable' });
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });

            // Two rebuilds with identical document content. The first matches the
            // subscribe-time baseline and is dropped; the second matches the (still-set)
            // last-emit baseline and is also dropped (recomputed root → same fingerprint).
            fireRebuild(bundle, doc);
            fireRebuild(bundle, doc);
            await tick(); // give a (wrongly) fired event a chance, then assert none arrived
            expect(events).toHaveLength(0);

            // A content change clears the dedup match → emission fires.
            const docChanged = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'mutated' });
            fireRebuild(bundle, docChanged);
            await waitFor(() => events.length === 1);
            expect(events).toHaveLength(1);
         } finally {
            pair.dispose();
         }
      });

      it('fires onDocumentUpdated when only diagnostics change between phase events', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });

            // Re-set the document with the same root but a new diagnostic — fingerprint
            // includes diagnostics, so this case must still emit (covers cascade rebuilds
            // where a dependent's change adds an unresolved-reference diagnostic without
            // changing this document's text).
            const docWithDiag = bundle.documents.set(
               URI_A,
               { $type: 'FakeRoot', name: 'A' },
               {
                  diagnostics: [
                     { type: 'validation-error', element: 'FakeRoot', message: 'broken', severity: 'error', code: 'unresolved-ref' }
                  ] as FakeDiagnostic[]
               }
            );
            bundle.documentBuilder.firePhase(DocumentState.Validated, docWithDiag);
            await waitFor(() => events.length === 1);
            expect(events).toHaveLength(1);
            expect(events[0]?.document.diagnostics).toHaveLength(1);
         } finally {
            pair.dispose();
         }
      });

      it('default transfer-document strategy emits when the root changes but text/diagnostics do not', async () => {
         const bundle = buildBundle();
         // baseline: a derived (computed) property `_eff` not reflected in the
         // serialised text, with text pinned so only the root differs below
         bundle.documents.set(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'x', _eff: 'a' }), { text: 'FIXED' });
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });

            // Change ONLY the derived property; text and diagnostics are identical.
            // The text+diagnostics strategy would suppress this; the transfer-document
            // default (which hashes the folded root) must emit.
            const changed = bundle.documents.set(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'x', _eff: 'b' }), {
               text: 'FIXED'
            });
            fireRebuild(bundle, changed);
            await waitFor(() => events.length === 1);
            expect(events).toHaveLength(1);
         } finally {
            pair.dispose();
         }
      });

      it('text-diagnostics strategy suppresses a root-only change the default emits', async () => {
         // The mirror of the test above: same fixture, same edit, opposite
         // expectation. Identical text and diagnostics means an identical hash,
         // so the root-only change is de-duplicated away.
         const bundle = buildBundle();
         bundle.documents.set(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'x', _eff: 'a' }), { text: 'FIXED' });
         const { proxy, events, pair } = makeDataServerHarness<TestDataServer, FakeRoot, FakeDiagnostic>({
            server: channel => new TestDataServer(channel, bundle.services, { fingerprintStrategy: 'text-diagnostics' })
         });
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });

            const changed = bundle.documents.set(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'x', _eff: 'b' }), {
               text: 'FIXED'
            });
            fireRebuild(bundle, changed);
            // Nothing to wait FOR, so settle the connection and assert absence.
            await tick(20);
            expect(events).toHaveLength(0);
         } finally {
            pair.dispose();
         }
      });

      it('skips onDocumentUpdated when the phase event arrives with a cancelled token', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'initial' });
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            const changed = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'changed' });
            // Cancelled token simulates a build preempted by a concurrent write
            // lock — the subscription event is stale by the time it would fire.
            const cancelled = {
               isCancellationRequested: true,
               onCancellationRequested: () => Disposable.EMPTY
            };
            fireRebuild(bundle, changed, cancelled);
            await tick(); // give a (wrongly) fired event a chance, then assert none arrived
            expect(events).toHaveLength(0);

            // Subsequent uncancelled fire still emits — the guard is per-event, not sticky.
            const changedAgain = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'changed-again' });
            fireRebuild(bundle, changedAgain);
            await waitFor(() => events.length === 1);
            expect(events).toHaveLength(1);
         } finally {
            pair.dispose();
         }
      });
   });

   describe('revert-on-close broadcast', () => {
      it('broadcasts the rebuild after the LAST client closed an unsubscribed document, attributed to the revert author', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'session-edited' });
         bundle.textDocuments.seedOpen(URI_A, 'name:session-edited', 'editor-1');
         const { events, pair } = makeHarness(bundle.services);
         try {
            // No watchModelDocument call — a request-only consumer holds no subscription.
            bundle.textDocuments.fireClose(URI_A, 'editor-1');
            // The close-triggered rebuild reverts the document to its disk content.
            const reverted = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'disk' });
            fireRebuild(bundle, reverted);
            await waitFor(() => events.length === 1);

            expect(events[0]?.document.uri).toBe(URI_A);
            expect(events[0]?.sourceClientId).toBe(REVERT_ON_CLOSE_CLIENT_ID);
         } finally {
            pair.dispose();
         }
      });

      it('stays silent when another client still holds the document open', async () => {
         const bundle = buildBundle();
         const document = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'shared' });
         bundle.textDocuments.seedOpen(URI_A, 'name:shared', 'editor-1');
         bundle.textDocuments.seedOpenInLanguageClient(URI_A);
         const { events, pair } = makeHarness(bundle.services);
         try {
            bundle.textDocuments.fireClose(URI_A, 'editor-1');
            fireRebuild(bundle, document);
            await tick(); // give a (wrongly) fired event a chance, then assert none arrived
            expect(events).toHaveLength(0);
         } finally {
            pair.dispose();
         }
      });

      it('keeps the pending mark across a cancelled dispatch and broadcasts on the follow-up build', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'session-edited' });
         bundle.textDocuments.seedOpen(URI_A, 'name:session-edited', 'editor-1');
         const { events, pair } = makeHarness(bundle.services);
         try {
            bundle.textDocuments.fireClose(URI_A, 'editor-1');
            const reverted = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'disk' });
            const cancelled = {
               isCancellationRequested: true,
               onCancellationRequested: () => Disposable.EMPTY
            };
            fireRebuild(bundle, reverted, cancelled);
            await tick();
            expect(events).toHaveLength(0);

            fireRebuild(bundle, reverted);
            await waitFor(() => events.length === 1);
            expect(events[0]?.sourceClientId).toBe(REVERT_ON_CLOSE_CLIENT_ID);
         } finally {
            pair.dispose();
         }
      });

      it('suppresses the broadcast when the disk state equals the last emitted state (no discarded edits)', async () => {
         const bundle = buildBundle();
         const document = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'clean' });
         bundle.textDocuments.seedOpen(URI_A, 'name:clean', 'editor-1');
         const { proxy, events, pair } = makeHarness(bundle.services);
         try {
            // A subscriber initialises the emission fingerprint to the current state.
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            bundle.textDocuments.fireClose(URI_A, 'editor-1');
            // Close without edits: the rebuild re-yields the identical state.
            fireRebuild(bundle, document);
            await tick();
            expect(events).toHaveLength(0);
         } finally {
            pair.dispose();
         }
      });
   });

   describe('getProjects', () => {
      it('reflects the ProjectManager.getProjects() output', async () => {
         const bundle = buildBundle();
         bundle.projectManager.projects.push({ id: 'p1', referenceName: 'p1', version: '1.0.0', dependencies: ['p0'] });
         bundle.projectManager.projects.push({ id: 'p2', referenceName: 'p2' });
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            const result = await proxy.getProjects();
            expect(result).toEqual([
               { id: 'p1', referenceName: 'p1', version: '1.0.0', dependencies: ['p0'] },
               { id: 'p2', referenceName: 'p2', version: undefined, dependencies: undefined }
            ]);
         } finally {
            pair.dispose();
         }
      });
   });

   describe('getProjectForUri', () => {
      it('returns the project the URI is mapped to via ProjectManager.getProject', async () => {
         const bundle = buildBundle();
         bundle.projectManager.projects.push({ id: 'p1', referenceName: 'p1', version: '1.0.0' });
         bundle.projectManager.projects.push({ id: 'p2', referenceName: 'p2' });
         bundle.projectManager.ownUri(URI_A, 'p1');
         bundle.projectManager.ownUri(URI_B, 'p2');
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            const ownedA = await proxy.getProjectForUri({ uri: URI_A });
            expect(ownedA).toEqual({ id: 'p1', referenceName: 'p1', version: '1.0.0', dependencies: undefined });

            const ownedB = await proxy.getProjectForUri({ uri: URI_B });
            expect(ownedB?.id).toBe('p2');

            // vscode-jsonrpc normalises `undefined` to `null` across the wire.
            const unowned = await proxy.getProjectForUri({ uri: 'file:///workspace/unowned.fake' });
            expect(unowned ?? undefined).toBeUndefined();
         } finally {
            pair.dispose();
         }
      });
   });

   describe('onProjectsChanged', () => {
      it('fans an internal ProjectChangeEvent into one wire notification per affected project', async () => {
         const bundle = buildBundle();
         bundle.projectManager.projects.push({ id: 'p1', referenceName: 'p1', version: '1.0.0' });
         bundle.projectManager.projects.push({ id: 'p2', referenceName: 'p2' });
         const removedSnapshot = { id: 'p0', referenceName: 'p0', version: '0.9.0', dependencies: [] as readonly string[] };

         const projectEvents: { project: { id: string }; reason: string }[] = [];
         const localClient: DataClientProtocol<FakeRoot, FakeDiagnostic> = {
            onDocumentUpdated(): void {
               // not exercised by this test
            },
            onDocumentSaved(): void {
               // not exercised by this test
            },
            onProjectsChanged(event): void {
               projectEvents.push({ project: { id: event.project.id }, reason: event.reason });
            }
         };
         const pair = makeDuplexConnectionPair();
         new TestDataServer(pair.left, bundle.services);
         // Bind the local client's notification handlers inbound; the returned
         // server proxy is unused here (this test asserts on the bound handlers).
         createRpcProxy<DataServerProtocol<FakeRoot, FakeDiagnostic>, DataClientProtocol<FakeRoot, FakeDiagnostic>>(pair.right, {
            methodNamespace: DATA_SERVER_WIRE_PREFIX,
            localTarget: localClient,
            localMethods: DATA_CLIENT_PROTOCOL_METHODS
         });

         try {
            bundle.projectManager.fireProjectsChanged({
               added: ['p1', 'p2'],
               updated: [],
               removed: [{ id: 'p0', snapshot: removedSnapshot }],
               affectedDocuments: []
            });
            await waitFor(() => projectEvents.length === 3);

            expect(projectEvents).toEqual([
               { project: { id: 'p1' }, reason: 'added' },
               { project: { id: 'p2' }, reason: 'added' },
               { project: { id: 'p0' }, reason: 'removed' }
            ]);
         } finally {
            pair.dispose();
         }
      });
   });

   describe('dispose', () => {
      it('clears the subscription map and fingerprint cache, drops listeners, and is idempotent', async () => {
         const bundle = buildBundle();
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const { server, proxy, events, pair } = makeHarness(bundle.services);
         try {
            await proxy.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            // Verify the server holds per-connection state we expect dispose to release.
            // Access protected fields via cast — this test asserts internal invariants.
            const internal = server as unknown as {
               subscriptions: Map<string, unknown>;
               lastEmittedFingerprint: Map<string, string>;
               disposables: { disposed: boolean };
            };
            expect(internal.subscriptions.size).toBe(1);
            expect(internal.lastEmittedFingerprint.size).toBe(1);
            expect(internal.disposables.disposed).toBe(false);

            server.dispose();

            expect(internal.subscriptions.size).toBe(0);
            expect(internal.lastEmittedFingerprint.size).toBe(0);
            expect(internal.disposables.disposed).toBe(true);

            // Listeners are gone: a phase event for the previously-subscribed URI
            // doesn't fan out (even disregarding the now-empty subscription map,
            // the listener itself is unhooked).
            const docChanged = bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A-changed' });
            bundle.documentBuilder.firePhase(DocumentState.Validated, docChanged);
            await tick(); // give a (wrongly) fired event a chance, then assert none arrived
            expect(events).toHaveLength(0);

            // Idempotent.
            expect(() => server.dispose()).not.toThrow();
         } finally {
            pair.dispose();
         }
      });

      it('registers a self-cleanup handler on connection.onClose so adopters who do not hold a reference still get cleanup', async () => {
         const bundle = buildBundle();
         // Spy on `connection.onClose` before constructing the server and
         // capture the listener it registers. Firing the captured listener
         // directly exercises the connection-close path without relying on
         // stream-destroy ordering inside the duplex helper — vscode-jsonrpc
         // deliberately does NOT fire `closeEmitter` once `connection.dispose()`
         // has run, so destroying streams via the pair's dispose-then-destroy
         // ordering would suppress the signal.
         const pair = makeDuplexConnectionPair();
         // Multiple call sites in the constructor register onClose handlers
         // (createRpcProxy registers one for the client proxy's connection
         // lifecycle events; DataServer itself registers its self-cleanup
         // handler). Capture ALL of them and fire all so the test exercises
         // the same close fan-out a real connection.onClose firing would.
         const capturedListeners: Array<() => void> = [];
         const originalOnClose = pair.left.onClose.bind(pair.left);
         const onCloseSpy = vi.spyOn(pair.left, 'onClose').mockImplementation((listener: () => void): Disposable => {
            capturedListeners.push(listener);
            return originalOnClose(listener);
         });
         const server = new TestDataServer(pair.left, bundle.services);
         try {
            await server.watchModelDocument({ uri: URI_A, clientId: 'sub-1' });
            const internal = server as unknown as { subscriptions: Map<string, unknown>; disposables: { disposed: boolean } };
            expect(internal.subscriptions.size).toBe(1);
            expect(onCloseSpy).toHaveBeenCalled();
            expect(capturedListeners.length).toBeGreaterThan(0);

            // Fire every captured close listener: simulates the wire peer
            // going away from the DataServer's perspective.
            for (const listener of capturedListeners) {
               listener();
            }

            expect(internal.subscriptions.size).toBe(0);
            expect(internal.disposables.disposed).toBe(true);
         } finally {
            onCloseSpy.mockRestore();
            pair.dispose();
         }
      });
   });

   describe('waitForReady', () => {
      it('default impl is bound on the wire and resolves promptly', async () => {
         const bundle = buildBundle();
         const { proxy, pair } = makeHarness(bundle.services);
         try {
            // The proxy's get-trap answers every name with a dispatching function,
            // so only a completed round trip witnesses the server-side binding.
            // The unbound name keeps the resolve below from being a tautology.
            const unbound = proxy as unknown as { notAWireMethod(): Promise<void> };
            await expect(unbound.notAWireMethod()).rejects.toThrow(`Unhandled method ${DATA_SERVER_WIRE_PREFIX}notAWireMethod`);

            let timer: ReturnType<typeof setTimeout> | undefined;
            const outcome = await Promise.race([
               proxy.waitForReady().then(() => 'ready'),
               new Promise<string>(resolve => {
                  timer = setTimeout(() => resolve('still-waiting'), 500);
               })
            ]);
            clearTimeout(timer);
            expect(outcome).toBe('ready');
         } finally {
            pair.dispose();
         }
      });
   });

   describe('namespace and additionalMethods', () => {
      it('registers framework methods under a custom methodNamespace', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            new TestDataServer(pair.left, bundle.services, { methodNamespace: 'adopter/' });
            const proxy = createRpcProxy<DataServerProtocol<FakeRoot, FakeDiagnostic>>(pair.right, {
               methodNamespace: 'adopter/'
            });
            const result = await proxy.getProjects();
            expect(result).toBeDefined();
         } finally {
            pair.dispose();
         }
      });

      it('registers additional adopter methods alongside framework methods', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            class AdopterDataServer extends DataServer<FakeRoot, FakeDiagnostic> {
               async customMethod(args: { value: number }): Promise<{ doubled: number }> {
                  return { doubled: args.value * 2 };
               }
            }
            new AdopterDataServer(pair.left, bundle.services, {
               methodNamespace: 'adopter/',
               additionalMethods: ['customMethod']
            });

            // Framework method still works under the adopter namespace.
            const frameworkProxy = createRpcProxy<DataServerProtocol<FakeRoot, FakeDiagnostic>>(pair.right, {
               methodNamespace: 'adopter/'
            });
            expect(await frameworkProxy.getProjects()).toBeDefined();

            // Adopter method is dispatched on the same connection under the same namespace.
            const adopterProxy = pair.right;
            const result = await adopterProxy.sendRequest<{ doubled: number }>('adopter/customMethod', { value: 21 });
            expect(result).toEqual({ doubled: 42 });
         } finally {
            pair.dispose();
         }
      });

      it('registers built-in diagnostics methods and returns formatted snapshots', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            const serverState = await diagnostics.dumpServerState({});
            expect(serverState).toContain('Server state snapshot');
            const podMemory = await diagnostics.dumpPodMemory();
            expect(podMemory).toContain('Pod memory snapshot');
         } finally {
            pair.dispose();
         }
      });

      it('defaults the diagnostics provider so a Node host passes nothing', async () => {
         // The default is selected by package.json's `browser` field, so under
         // Node this resolves to the real implementation with no wiring. A
         // browser bundle gets the twin instead; that swap is a bundler
         // behaviour, so `check:neutral` is what proves it, not this suite.
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            new TestDataServer(pair.left, bundle.services);
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            expect(await diagnostics.dumpPodMemory()).toContain('Pod memory snapshot');
         } finally {
            pair.dispose();
         }
      });

      it('the browser default rejects each method by naming the absent capability', async () => {
         // Asserted against the module directly: it is the branch a browser
         // bundle binds, and no Node test run can reach it through the bundler.
         // It must THROW rather than no-op — an empty snapshot reads as a
         // healthy server, which is the same shape as a real answer.
         const provider = browserDefaultDiagnostics();
         await expect(provider.dumpPodMemory()).rejects.toThrow('no process to inspect');
         await expect(provider.writeHeapSnapshot({})).rejects.toThrow('no process to inspect');
         await expect(provider.startProfiling({})).rejects.toThrow('no process to inspect');
      });

      it('startProfiling then stopProfiling captures a window and returns a formatted report', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            await diagnostics.startProfiling({ gc: true });
            await new Promise(resolve => setTimeout(resolve, 5));
            const report = await diagnostics.stopProfiling({});
            expect(report).toContain('Profile report:');
            expect(report).toContain('duration');
         } finally {
            pair.dispose();
         }
      });

      it('stopProfiling folds the window report into server-summary.json when a directory is given', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         const dir = mkdtempSync(join(tmpdir(), 'hydranium-ds-summary-'));
         try {
            new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            await diagnostics.startProfiling({ gc: true });
            await new Promise(resolve => setTimeout(resolve, 5));
            await diagnostics.stopProfiling({ directory: dir, label: 'scenario' });
            const summary = JSON.parse(readFileSync(join(dir, 'server-summary.json'), 'utf8'));
            expect(typeof summary.scenario.durationMs).toBe('number');
         } finally {
            pair.dispose();
            rmSync(dir, { recursive: true, force: true });
         }
      });

      it('collects per-method RPC latency when a LatencyCollector is supplied and returns it via getLatency', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            const latency = new LatencyCollector();
            new TestDataServer(pair.left, bundle.services, { latency });
            const diagnostics = createRpcProxy<
               DataServerDiagnosticsProtocol & Pick<DataServerProtocol<FakeRoot, FakeDiagnostic>, 'getProjects'>
            >(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            await diagnostics.getProjects();
            const report = await diagnostics.getLatency();
            expect(report.methods.some(methodLatency => methodLatency.method === 'data-server/getProjects')).toBe(true);
         } finally {
            pair.dispose();
         }
      });

      it('stopProfiling rejects when no capture is active', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            // Matched on the message, not merely on rejecting: `toBeDefined`
            // is satisfied by a wrong namespace, an unregistered method or a
            // torn socket, none of which is the guard under test.
            await expect(diagnostics.stopProfiling({})).rejects.toThrow(/No profiling capture is active/);
         } finally {
            pair.dispose();
         }
      });

      describe('server-side rendering of the rejection', () => {
         /**
          * Renders `NO_ACTIVE_PROFILE` and nothing else, so an assertion says
          * which message was rendered rather than that something was.
          */
         class ProfileCatalogueRenderer extends DefaultMessageRenderer {
            protected override translationsFor(locale: string | undefined): Record<string, string> | undefined {
               return locale === 'xx-AA' ? { [NO_ACTIVE_PROFILE.code]: 'AA: kein Profil' } : undefined;
            }
         }

         /** Drive `stopProfiling` with no capture active and return the rejection message. */
         async function rejectionMessage(bundle: Bundle): Promise<string> {
            const pair = makeDuplexConnectionPair();
            try {
               new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
               const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
                  methodNamespace: DATA_SERVER_WIRE_PREFIX
               });
               // The message as it CROSSED THE WIRE — the identity is rendered at
               // the response boundary, so reading the thrown object server-side
               // would not distinguish rendered from unrendered.
               return await diagnostics.stopProfiling({}).then(
                  () => 'resolved, but the guard should have rejected',
                  (err: unknown) => (err instanceof Error ? err.message : String(err))
               );
            } finally {
               pair.dispose();
            }
         }

         it('renders an identity-bearing rejection in the installed locale', async () => {
            const bundle = makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
               serialize: (_uri, root) => `name:${root.name}`,
               locale: 'xx-AA',
               messageRenderer: services => new ProfileCatalogueRenderer(services)
            });

            expect(await rejectionMessage(bundle)).toBe('AA: kein Profil');
         });

         it('sends the English when no catalogue matches — the control on the row above', async () => {
            // Same renderer, different locale: a default-English assertion would
            // otherwise pass with the render never happening at all.
            const bundle = makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
               serialize: (_uri, root) => `name:${root.name}`,
               locale: 'zz-ZZ',
               messageRenderer: services => new ProfileCatalogueRenderer(services)
            });

            expect(await rejectionMessage(bundle)).toBe(NO_ACTIVE_PROFILE.text);
         });

         it('keeps the numeric code and the identity envelope, which the render must not consume', async () => {
            const bundle = makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
               serialize: (_uri, root) => `name:${root.name}`,
               locale: 'xx-AA',
               messageRenderer: services => new ProfileCatalogueRenderer(services)
            });
            const pair = makeDuplexConnectionPair();
            try {
               new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
               const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
                  methodNamespace: DATA_SERVER_WIRE_PREFIX
               });
               const rejection = await diagnostics.stopProfiling({}).then(
                  () => undefined,
                  (err: unknown) => err as ResponseError<unknown>
               );

               // The boundary RECONSTRUCTS the rejection, so this pins that it
               // reconstructs it faithfully: the numeric code is what a caller
               // switches on, and the envelope is what identifies the message
               // now that nothing renders from it client-side.
               expect(rejection?.code).toBe(NO_ACTIVE_PROFILE_CODE);
               expect(resolvedFromResponseError(rejection!)?.code).toBe(NO_ACTIVE_PROFILE.code);
            } finally {
               pair.dispose();
            }
         });

         it('leaves a plain Error alone, since it carries no identity to render', async () => {
            // A developer-facing failure must not be relabelled as a translated
            // one, so only a ResponseError reaches the renderer. Asserted by
            // whether the renderer was CONSULTED: the message being unchanged is
            // also what a renderer with no catalogue produces, so it cannot
            // distinguish "not consulted" from "consulted and passed through".
            const consulted: string[] = [];
            class RecordingRenderer extends DefaultMessageRenderer {
               override renderError(error: ResponseError<unknown>): string {
                  consulted.push(error.message);
                  return super.renderError(error);
               }
            }
            const bundle = makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
               serialize: (_uri, root) => `name:${root.name}`,
               messageRenderer: services => new RecordingRenderer(services)
            });
            const pair = makeDuplexConnectionPair();
            try {
               new PlainFailureServer(pair.left, bundle.services, {
                  diagnostics: nodeDataServerDiagnostics(),
                  additionalMethods: ['failPlain']
               });
               const proxy = createRpcProxy<{ failPlain(): Promise<never> }>(pair.right, {
                  methodNamespace: DATA_SERVER_WIRE_PREFIX
               });

               const message = await proxy.failPlain().then(
                  () => 'resolved',
                  (err: unknown) => (err instanceof Error ? err.message : String(err))
               );

               expect(message).toContain('a developer-facing failure');
               expect(consulted).toEqual([]);
            } finally {
               pair.dispose();
            }
         });

         it('consults the renderer for a ResponseError — the control on the row above', async () => {
            // Same server, same recording renderer: only the thrown TYPE differs,
            // so an empty `consulted` above means the guard discriminated rather
            // than that the hook was never wired.
            const consulted: string[] = [];
            class RecordingRenderer extends DefaultMessageRenderer {
               override renderError(error: ResponseError<unknown>): string {
                  consulted.push(error.message);
                  return super.renderError(error);
               }
            }
            const bundle = makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
               serialize: (_uri, root) => `name:${root.name}`,
               messageRenderer: services => new RecordingRenderer(services)
            });
            const pair = makeDuplexConnectionPair();
            try {
               new PlainFailureServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
               const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
                  methodNamespace: DATA_SERVER_WIRE_PREFIX
               });

               await diagnostics.stopProfiling({}).catch(() => undefined);

               expect(consulted).toEqual([NO_ACTIVE_PROFILE.text]);
            } finally {
               pair.dispose();
            }
         });
      });

      it('dispose() stops an in-flight capture and releases the process-wide singleton', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            const server = new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            await diagnostics.startProfiling({ gc: true });
            expect(ProfileCapture.isActive()).toBe(true);
            server.dispose();
            // dispose stops the capture fire-and-forget; wait for the singleton to clear.
            await waitFor(() => !ProfileCapture.isActive());
            expect(ProfileCapture.isActive()).toBe(false);
         } finally {
            pair.dispose();
         }
      });

      it('startProfiling after the server is disposed stops the capture instead of leaking the singleton', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            const server = new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            server.dispose();
            // A capture that resolves after the connection closed (dispose already ran, so it
            // saw no activeProfile) must be stopped here, not left wedging the singleton.
            await server.startProfiling({ gc: true });
            expect(ProfileCapture.isActive()).toBe(false);
         } finally {
            pair.dispose();
         }
      });

      it('rejects a second concurrent startProfiling while one is active', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            await diagnostics.startProfiling({ gc: true });
            await expect(diagnostics.startProfiling({ gc: true })).rejects.toThrow(/already active/);
            await diagnostics.stopProfiling({});
            expect(ProfileCapture.isActive()).toBe(false);
         } finally {
            pair.dispose();
         }
         // Same V8-bound headroom as the heap-snapshot case below: a capture
         // requested with `gc: true` forces a collection before it starts, and
         // that pause is charged to whatever CPU the runner has left.
      }, 30_000);

      it('writeHeapSnapshot writes a snapshot file to the given directory', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         const dir = mkdtempSync(join(tmpdir(), 'hydranium-ds-heap-'));
         try {
            new TestDataServer(pair.left, bundle.services, { diagnostics: nodeDataServerDiagnostics() });
            const diagnostics = createRpcProxy<DataServerDiagnosticsProtocol>(pair.right, {
               methodNamespace: DATA_SERVER_WIRE_PREFIX
            });
            const filePath = await diagnostics.writeHeapSnapshot({ directory: dir });
            expect(filePath.endsWith('.heapsnapshot')).toBe(true);
            expect(existsSync(filePath)).toBe(true);
         } finally {
            pair.dispose();
            rmSync(dir, { recursive: true, force: true });
         }
         // Generous timeout: a V8 heap snapshot serializes the whole heap to
         // disk, so its cost tracks heap size and the executor's disk
         // throughput rather than anything this test does. A shared CI runner
         // bounds both far below a developer machine. Headroom, not a weaker
         // assertion — the path and the file's existence are still asserted.
      }, 30_000);

      it('throws when additionalMethods overlaps with a built-in framework method', () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            expect(
               () =>
                  new TestDataServer(pair.left, bundle.services, {
                     additionalMethods: ['getProjects', 'getModelDocument']
                  })
            ).toThrow(/overlaps with built-in data-server methods: getProjects, getModelDocument/);
         } finally {
            pair.dispose();
         }
      });

      it('excludedMethods drops framework names from the wire registration', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            new TestDataServer(pair.left, bundle.services, {
               methodNamespace: 'adopter/',
               excludedMethods: ['getProjects']
            });

            // getProjects no longer answers under the adopter namespace.
            await expect(pair.right.sendRequest('adopter/getProjects', undefined)).rejects.toBeDefined();

            // Other framework methods stay registered (getProjectForUri here — pick one with a
            // minimal arg shape that doesn't require document state to exist).
            await expect(pair.right.sendRequest('adopter/getProjectForUri', { uri: URI_A })).resolves.toBeDefined();
         } finally {
            pair.dispose();
         }
      });

      it('excludedMethods composes with additionalMethods (rename pattern: exclude framework name, add domain-name equivalent)', async () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            class RenamedServer extends DataServer<FakeRoot, FakeDiagnostic> {
               // Domain-named replacement that delegates to the inherited framework method.
               async getAdopterProjects(): Promise<readonly { id: string }[]> {
                  return this.getProjects() as Promise<readonly { id: string }[]>;
               }
            }
            new RenamedServer(pair.left, bundle.services, {
               methodNamespace: 'adopter/',
               additionalMethods: ['getAdopterProjects'],
               excludedMethods: ['getProjects']
            });

            // Domain-named method answers; framework name does not.
            const renamed = await pair.right.sendRequest<readonly { id: string }[]>('adopter/getAdopterProjects', undefined);
            expect(renamed).toBeDefined();
            await expect(pair.right.sendRequest('adopter/getProjects', undefined)).rejects.toBeDefined();
         } finally {
            pair.dispose();
         }
      });

      it('excludedMethods ignores names that are neither framework nor adopter', () => {
         const bundle = buildBundle();
         const pair = makeDuplexConnectionPair();
         try {
            // Listing an unknown name is a no-op (no throw, no effect).
            expect(() => new TestDataServer(pair.left, bundle.services, { excludedMethods: ['notAMethod'] })).not.toThrow();
         } finally {
            pair.dispose();
         }
      });
   });
});

// ============================================================
// Reference resolution — sole-language fallback + document-aware wait.
// Single-language registry where only `.fake` URIs resolve to a language; an
// extensionless directory URI, which a synthetic source can carry, resolves
// to none and must fall back to the sole language rather than throw.
// ============================================================

/** Single-language registry stub: `.fake` URIs resolve, a directory URI does not. */
function makeReferenceServices(bundle: Bundle, candidates: ReferenceCandidate[]): ServerSharedServices {
   const registry = makeStubServiceRegistry([
      {
         languageId: 'fake',
         fileExtensions: ['.fake'],
         services: {
            references: { CandidateProvider: { find: (_ctx: ReferenceContext) => candidates, resolveCandidate: () => undefined } }
         }
      }
   ]);
   return { ...bundle.services, ServiceRegistry: registry } as unknown as ServerSharedServices;
}

describe('DataServer — reference resolution', () => {
   const DIR_URI = 'file:///workspace/ns'; // extensionless directory: no language, no document
   const SYN_URI = 'file:///workspace/syn.fake';

   it('falls back to the sole language when a synthetic source URI matches no registered language', async () => {
      const bundle = buildBundle();
      const candidates = [{ label: 'attr' } as unknown as ReferenceCandidate];
      const { server, pair } = makeHarness(makeReferenceServices(bundle, candidates));
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(DIR_URI, 'TypeTwo'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).resolves.toBe(candidates);
      } finally {
         pair.dispose();
      }
   });

   it('waits globally (no URI) when the source document is not loaded', async () => {
      const bundle = buildBundle();
      const { server, pair } = makeHarness(makeReferenceServices(bundle, []));
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(SYN_URI, 'TypeTwo'), property: 'ref' };
         await server.findReferenceCandidates(ctx);
         const last = bundle.documentBuilder.waitUntilCalls.at(-1)!;
         expect(last.args[0]).toBe(DocumentState.Linked);
         expect(last.args[1]).toBeUndefined();
      } finally {
         pair.dispose();
      }
   });

   it('waits on the source URI when its document is loaded', async () => {
      const bundle = buildBundle();
      bundle.documents.set(SYN_URI, { $type: 'FakeRoot', name: 'x' });
      const { server, pair } = makeHarness(makeReferenceServices(bundle, []));
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(SYN_URI, 'TypeTwo'), property: 'ref' };
         await server.findReferenceCandidates(ctx);
         const last = bundle.documentBuilder.waitUntilCalls.at(-1)!;
         expect(last.args[1]?.toString()).toBe(URI.parse(SYN_URI).toString());
      } finally {
         pair.dispose();
      }
   });

   it('throws for an unresolvable source URI in a multi-language workspace', async () => {
      const bundle = buildBundle();
      // Two registered languages → no sole-language fallback; an unresolvable
      // URI (matches neither, and neither grammar produces the source type)
      // must throw rather than silently pick one.
      const candidateProvider = { CandidateProvider: { find: () => [], resolveCandidate: () => undefined } };
      const registry = makeStubServiceRegistry([
         { languageId: 'first', fileExtensions: ['.first'], services: { references: candidateProvider } },
         { languageId: 'second', fileExtensions: ['.second'], services: { references: candidateProvider } }
      ]);
      const services = { ...bundle.services, ServiceRegistry: registry } as unknown as ServerSharedServices;
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(DIR_URI, 'TypeTwo'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).rejects.toThrow(/multi-language/);
      } finally {
         pair.dispose();
      }
   });
});

// ============================================================
// Reference resolution — multi-language routing.
// An `ElementSource` carries no URI, so the sole-language shortcut cannot
// serve it once a second language is registered; it routes via the document
// the index says holds the element. Everything still unresolved is adopter
// policy (`fallbackReferenceLanguage`).
// ============================================================

/** One language descriptor whose candidates identify it, so a test can assert WHICH language answered. */
function makeLanguageStub(
   label: string,
   producedTypes: readonly string[]
): { candidates: ReferenceCandidate[]; nameCalls: string[]; descriptor: StubLanguageDescriptor } {
   const candidates = [{ label } as unknown as ReferenceCandidate];
   // Every name method answers `<label>:<method>` so a test can assert WHICH
   // language's NameProvider was reached AND which tier was taken.
   const nameCalls: string[] = [];
   const record = (method: string): string => {
      nameCalls.push(method);
      return `${label}:${method}`;
   };
   return {
      candidates,
      nameCalls,
      descriptor: {
         languageId: label,
         fileExtensions: [`.${label}`],
         producedTypes,
         services: {
            references: {
               CandidateProvider: { find: () => candidates, resolveCandidate: () => undefined },
               NameProvider: {
                  findNextName: () => record('local'),
                  findNextDocumentQualifiedName: (_type: string, _base: string, projectId: string) => record(`project(${projectId})`),
                  findNextProjectQualifiedName: () => record('public')
               }
            }
         }
      }
   };
}

/** An index entry as `IndexManager.allElements` reports it. */
interface IndexEntry {
   readonly name: string;
   readonly type: string;
   readonly documentUri: string;
}

/** What {@link makeMultiLanguageServices} hands back per registered language. */
interface MultiLanguageStub {
   readonly candidates: ReferenceCandidate[];
   /** Name-method names this language answered, in call order. */
   readonly nameCalls: string[];
   /** The registered per-language services, for tests that need the tree itself. */
   readonly services: ServerLanguageServices | undefined;
}

/**
 * Two-language registry (`.fake` / `.other`) over an index stub. No URI outside
 * those two extensions resolves, so `all.length === 1` never short-circuits and
 * the id-based path is exercised.
 *
 * Routing runs through the framework's own {@link makeStubServiceRegistry} —
 * a real `ExtendedServiceRegistry` — rather than a hand-rolled lookup, so
 * `getServices` / `hasServices` behave here exactly as they do in a booted
 * server.
 */
function makeMultiLanguageServices(
   bundle: Bundle,
   entries: readonly IndexEntry[],
   /**
    * Types each language's grammar PRODUCES, feeding the type→language routing
    * step. A minimal parser rule per type is all `collectProducibleTypes` reads.
    */
   producedTypes: { fake?: readonly string[]; other?: readonly string[] } = {}
): { services: ServerSharedServices; fake: MultiLanguageStub; other: MultiLanguageStub } {
   const fake = makeLanguageStub('fake', producedTypes.fake ?? []);
   const other = makeLanguageStub('other', producedTypes.other ?? []);
   const registry = makeStubServiceRegistry([fake.descriptor, other.descriptor]);
   // Mirrors `HydraniumIndexManager` — an exact-name lookup optionally
   // narrowed by type. `getElementsByName` returns every match (the router
   // abstains only when they disagree on the DOCUMENT); `getElementByName`
   // takes the first, as the real one does.
   const describeEntry = (entry: IndexEntry) => ({ name: entry.name, type: entry.type, documentUri: URI.parse(entry.documentUri) });
   const matching = (name: string, type?: string) =>
      entries.filter(candidate => candidate.name === name && (type === undefined || candidate.type === type)).map(describeEntry);
   const IndexManager = {
      getElementsByName: (name: string, type?: string) => matching(name, type),
      getElementByName: (name: string, type?: string) => matching(name, type)[0]
   };
   const services = {
      ...bundle.services,
      ServiceRegistry: registry,
      workspace: { ...bundle.services.workspace, IndexManager }
   } as unknown as ServerSharedServices;
   return {
      services,
      fake: { candidates: fake.candidates, nameCalls: fake.nameCalls, services: registry.languagesById.get('fake') },
      other: { candidates: other.candidates, nameCalls: other.nameCalls, services: registry.languagesById.get('other') }
   };
}

describe('DataServer — multi-language reference routing', () => {
   const DIR_URI = 'file:///workspace/ns';

   it('routes an element source to the language of the document that holds it', async () => {
      const bundle = buildBundle();
      const { services, other } = makeMultiLanguageServices(bundle, [
         { name: 'ns.Element', type: 'TypeOne', documentUri: 'file:///workspace/x.other' }
      ]);
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.element('ns.Element', 'TypeOne'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).resolves.toBe(other.candidates);
      } finally {
         pair.dispose();
      }
   });

   it('disambiguates same-named elements by the source type', async () => {
      const bundle = buildBundle();
      // Qualified names are unique per type only, so the type decides which of
      // the two `ns.Element` entries — and so which language — answers.
      const { services, fake } = makeMultiLanguageServices(bundle, [
         { name: 'ns.Element', type: 'TypeOne', documentUri: 'file:///workspace/x.other' },
         { name: 'ns.Element', type: 'TypeThree', documentUri: 'file:///workspace/x.fake' }
      ]);
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.element('ns.Element', 'TypeThree'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).resolves.toBe(fake.candidates);
      } finally {
         pair.dispose();
      }
   });

   it('falls through to the type step when one id names elements in both languages', async () => {
      const bundle = buildBundle();
      // Same name AND same type in two languages — the index cannot answer, and
      // answering with whichever document was built first would make routing
      // depend on file-watch order. Only `other` produces `TypeTwo`, so
      // step 4 resolves what step 3 honestly could not.
      const { services, other } = makeMultiLanguageServices(
         bundle,
         [
            { name: 'ns.Element', type: 'TypeTwo', documentUri: 'file:///workspace/a.fake' },
            { name: 'ns.Element', type: 'TypeTwo', documentUri: 'file:///workspace/b.other' }
         ],
         { fake: ['TypeOne'], other: ['TypeTwo'] }
      );
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.element('ns.Element', 'TypeTwo'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).resolves.toBe(other.candidates);
      } finally {
         pair.dispose();
      }
   });

   it('throws rather than guessing when an ambiguous id also names an ambiguous type', async () => {
      const bundle = buildBundle();
      // Both steps abstain: two documents hold the name, and both grammars can
      // produce the type. Registration order is never the answer.
      const { services } = makeMultiLanguageServices(
         bundle,
         [
            { name: 'ns.Element', type: 'SharedType', documentUri: 'file:///workspace/a.fake' },
            { name: 'ns.Element', type: 'SharedType', documentUri: 'file:///workspace/b.other' }
         ],
         { fake: ['SharedType'], other: ['SharedType'] }
      );
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.element('ns.Element', 'SharedType'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).rejects.toThrow(/multi-language/);
      } finally {
         pair.dispose();
      }
   });

   it('throws when the element id is absent from the index', async () => {
      const bundle = buildBundle();
      const { services } = makeMultiLanguageServices(bundle, []);
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.element('ns.Missing', 'TypeOne'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).rejects.toThrow(/multi-language/);
      } finally {
         pair.dispose();
      }
   });

   it('routes a synthetic source on a directory URI by the type its grammar produces', async () => {
      const bundle = buildBundle();
      // No usable URI, but a known AST type — the type step must carry it.
      const { services, other } = makeMultiLanguageServices(bundle, [], { fake: ['TypeOne'], other: ['TypeTwo'] });
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(DIR_URI, 'TypeTwo'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).resolves.toBe(other.candidates);
      } finally {
         pair.dispose();
      }
   });

   it('does not route by type when both grammars produce it', async () => {
      const bundle = buildBundle();
      // A type reached through a grammar both languages import identifies nothing.
      const { services } = makeMultiLanguageServices(bundle, [], { fake: ['SharedType'], other: ['SharedType'] });
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(DIR_URI, 'SharedType'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).rejects.toThrow(/multi-language/);
      } finally {
         pair.dispose();
      }
   });

   it('prefers the owning document over the type for an element source', async () => {
      const bundle = buildBundle();
      // The index says the element lives in a `.other` document while the type
      // is produced by the `.fake` grammar; the document is the stronger claim.
      const { services, other } = makeMultiLanguageServices(
         bundle,
         [{ name: 'ns.Element', type: 'TypeOne', documentUri: 'file:///x.other' }],
         { fake: ['TypeOne'], other: ['TypeTwo'] }
      );
      const { server, pair } = makeHarness(services);
      try {
         const ctx: ReferenceContext = { source: ReferenceSource.element('ns.Element', 'TypeOne'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).resolves.toBe(other.candidates);
      } finally {
         pair.dispose();
      }
   });

   it('serves a source that names no language from the fallbackReferenceLanguage override', async () => {
      const bundle = buildBundle();
      const { services, other } = makeMultiLanguageServices(bundle, []);
      const fallback = other.services as unknown as HydraniumLanguageServices;
      class FallbackDataServer extends DataServer<FakeRoot, FakeDiagnostic> {
         protected override fallbackReferenceLanguage(): HydraniumLanguageServices {
            return fallback;
         }
      }
      const harness = makeDataServerHarness<FallbackDataServer, FakeRoot, FakeDiagnostic>({
         server: channel => new FallbackDataServer(channel, services)
      });
      try {
         // A synthetic source on a directory URI, which names no language.
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(DIR_URI, 'TypeTwo'), property: 'ref' };
         await expect(harness.server.findReferenceCandidates(ctx)).resolves.toBe(other.candidates);
      } finally {
         harness.pair.dispose();
      }
   });
});

// ============================================================
// findNextName — routes through the SAME router as every other reference
// method. A bare `getServices(uri)` would throw on a directory URI, where
// `findReferenceCandidates` resolves via the fallback chain, so the two
// methods would disagree about which language owns one source.
// ============================================================

describe('DataServer — findNextName routing', () => {
   const DIR_URI = 'file:///workspace/ns';

   /** Give `uri` an owning project, so the project tier is exercised rather than the unowned widening. */
   function ownedBy(bundle: Bundle, uri: string, projectId: string): void {
      bundle.projectManager.projects.push({ id: projectId, referenceName: projectId });
      bundle.projectManager.ownUri(uri, projectId);
   }

   it('routes a directory URI by the AST type its grammar produces, instead of throwing', async () => {
      const bundle = buildBundle();
      const { services, other } = makeMultiLanguageServices(bundle, [], { fake: ['TypeOne'], other: ['TypeTwo'] });
      ownedBy(bundle, DIR_URI, 'p1');
      const { server, pair } = makeHarness(services);
      try {
         // A bare `getServices(DIR_URI)` throws "no services for the extension ''".
         await expect(server.findNextName({ uri: DIR_URI, type: 'TypeTwo', proposal: 'Proposal' })).resolves.toBe('other:project(p1)');
         expect(other.nameCalls).toEqual(['project(p1)']);
      } finally {
         pair.dispose();
      }
   });

   it('agrees with findReferenceCandidates on which language owns a source', async () => {
      const bundle = buildBundle();
      const { services, other } = makeMultiLanguageServices(bundle, [], { fake: ['TypeOne'], other: ['TypeTwo'] });
      const { server, pair } = makeHarness(services);
      try {
         // Same URI, same flow, so both methods must name the same language.
         const ctx: ReferenceContext = { source: ReferenceSource.synthetic(DIR_URI, 'TypeTwo'), property: 'ref' };
         await expect(server.findReferenceCandidates(ctx)).resolves.toBe(other.candidates);
         await expect(server.findNextName({ uri: DIR_URI, type: 'TypeTwo', proposal: 'Proposal' })).resolves.toMatch(/^other:/);
      } finally {
         pair.dispose();
      }
   });

   it('routes a URI that resolves by extension, passing its owning project id through', async () => {
      const bundle = buildBundle();
      const { services, fake } = makeMultiLanguageServices(bundle, []);
      ownedBy(bundle, URI_A, 'p1');
      const { server, pair } = makeHarness(services);
      try {
         await expect(server.findNextName({ uri: URI_A, type: 'TypeOne', proposal: 'Proposal' })).resolves.toBe('fake:project(p1)');
         expect(fake.nameCalls).toEqual(['project(p1)']);
      } finally {
         pair.dispose();
      }
   });

   it('widens to workspace-wide uniqueness when no project owns the URI', async () => {
      const bundle = buildBundle();
      const { services, fake } = makeMultiLanguageServices(bundle, []);
      const { server, pair } = makeHarness(services);
      try {
         // Filtering on `projectId: ''` instead would match no element, so the
         // taken-name set would be empty and the bare proposal would come back
         // however many collisions existed. Workspace-wide is the strict
         // superset: a name unique everywhere is unique in any one project.
         await expect(server.findNextName({ uri: URI_A, type: 'TypeOne', proposal: 'Proposal' })).resolves.toBe('fake:public');
         expect(fake.nameCalls).toEqual(['public']);
      } finally {
         pair.dispose();
      }
   });

   it('honours the public tier without consulting a project', async () => {
      const bundle = buildBundle();
      const { services, fake } = makeMultiLanguageServices(bundle, []);
      const { server, pair } = makeHarness(services);
      try {
         await expect(server.findNextName({ uri: URI_A, type: 'TypeOne', proposal: 'Proposal', tier: 'public' })).resolves.toBe(
            'fake:public'
         );
         expect(fake.nameCalls).toEqual(['public']);
      } finally {
         pair.dispose();
      }
   });

   it('honours the local tier by scoping uniqueness to the document root', async () => {
      // The `'local'` arm is the only one of the three that resolves a document:
      // it awaits `ensureDocumentState` and passes the root as the container to
      // the document-scoped `NameProvider.findNextName`. The other two answer from
      // the type and project alone.
      const bundle = makeTestServices<FakeRoot & { $type: string }, FakeDiagnostic, FakeRoot>({
         serialize: (_uri, root) => `name:${root.name}`,
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot & { $type: string }>({ $type: 'FakeRoot', name: 'root' }) }]
      });
      const { services, fake } = makeMultiLanguageServices(bundle, []);
      const { server, pair } = makeHarness(services);
      try {
         await expect(server.findNextName({ uri: URI_A, type: 'TypeOne', proposal: 'Proposal', tier: 'local' })).resolves.toBe(
            'fake:local'
         );
         // Asserts the TIER, not just the language: `local` is the document-scoped
         // method, so a regression routing this to `project(...)` or `public`
         // fails here rather than returning a plausible name from the wrong scope.
         expect(fake.nameCalls).toEqual(['local']);
      } finally {
         pair.dispose();
      }
   });

   it('throws the router error when nothing owns the source', async () => {
      const bundle = buildBundle();
      // Neither grammar produces this type and the URI resolves to no language,
      // so the router abstains rather than picking one — and does so with its
      // own actionable message, not Langium's extension error.
      const { services } = makeMultiLanguageServices(bundle, [], { fake: ['TypeOne'], other: ['TypeTwo'] });
      const { server, pair } = makeHarness(services);
      try {
         await expect(server.findNextName({ uri: DIR_URI, type: 'UnknownType', proposal: 'X' })).rejects.toThrow(/multi-language/);
      } finally {
         pair.dispose();
      }
   });
});
