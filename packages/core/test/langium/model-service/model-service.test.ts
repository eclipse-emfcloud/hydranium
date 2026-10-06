/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
   type CanonicalUri,
   asModelVersion,
   ConflictError,
   DefaultTracer,
   isConflictError,
   Logger,
   NoopLogger,
   type TransferElement,
   UNRECORDED_VERSION
} from '@hydranium/protocol';
import type { AstDiagnostic } from '../../../src/langium/validation/document-validator.js';
import { type FakeClock, makeFakeClock, tick, waitFor } from '@hydranium/protocol/testing';
import { type AstNode, DocumentState, type LangiumDocument, UriUtils, type WorkspaceLock } from '@hydranium/langium';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { IntegrityService } from '../../../src/langium/integrity/integrity-service.js';
import { DocumentNotOpenError, DuplicateClientIdError } from '../../../src/documents/client-session-errors.js';
import { type ClientSession } from '../../../src/langium/model-service/client-session.js';
import { DefaultModelService, type ModelService } from '../../../src/langium/model-service/model-service.js';
import { type ServerSharedServices } from '../../../src/langium/module.js';
import { type DocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import {
   type CapturedLine,
   makeCapturingLogger,
   makeFakeAstNode,
   makeNoopSharedServices,
   makeTestServices,
   type StubHydraniumTextDocuments
} from '../../../src/testing/index.js';
import { ReentrantWriteLockError, setWriteLockScope } from '../../../src/langium/workspace/write-lock-scope.js';
import { nodeWriteLockScope } from '../../../src/node/write-lock-scope-node.js';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const URI_A = 'file:///A.fake';

/**
 * ModelService variant whose `rebuild` advances the injected fake clock by a
 * configurable amount. Exercising the production `update` path against this
 * subclass lets the slow-warn measurement (`services.Clock.stopwatch()`) see a
 * synthetic latency deterministically — no real sleep, no flaky wall-clock —
 * without standing up a real Langium build pipeline.
 */
class DelayedModelService<TAst extends AstNode> extends DefaultModelService<TAst> {
   protected delayMs = 0;

   setDelay(ms: number): void {
      this.delayMs = ms;
   }

   override async rebuild(_uri: string, _state?: DocumentState): Promise<never> {
      if (this.delayMs > 0) {
         // The bundle binds a FakeClock on the Clock slot; advance virtual time
         // so the slow-warn stopwatch sees the synthetic latency deterministically.
         (this.services.Clock as FakeClock).advance(this.delayMs);
      }
      // The test asserts only on the slow-warn log line, not on the returned
      // doc envelope — production `update` reads the version after `rebuild`
      // resolves, which the stub TextDocuments handles via `version()` below.
      return undefined as never;
   }
}

/**
 * A session of `service` under `clientId` that has `uri` open in the stub
 * store, as its own open would leave it. Writes open nothing, so a write test
 * starts from here.
 */
function openSession<TTransfer extends TransferElement = TransferElement>(
   service: ModelService<FakeRoot, AstDiagnostic, TTransfer>,
   store: StubHydraniumTextDocuments,
   clientId: string,
   text = 'name: a\n',
   uri = URI_A
): ClientSession<FakeRoot, AstDiagnostic, TTransfer> {
   const session = service.createSession('test', clientId);
   if (store.get(uri)) {
      store.attachClient(uri, clientId);
   } else {
      store.seedOpen(uri, text, clientId);
   }
   return session;
}

/** A captured line with the logger component it was emitted under. */
interface AttributedLine extends CapturedLine {
   readonly component: string | undefined;
}

/** A capturing logger that also records each line's component, which `makeCapturingLogger` drops. */
function makeAttributingLogger(): { logger: Logger; lines: AttributedLine[] } {
   const lines: AttributedLine[] = [];
   class Attributing extends NoopLogger {
      protected override emit(level: AttributedLine['level'], _label: string, message: string): void {
         lines.push({ level, message, component: this.component });
      }
      protected override derive(component: string): this {
         return new Attributing(component) as this;
      }
   }
   return { logger: new Attributing(), lines };
}

/**
 * The service is bound on the `model.ModelService` slot: the session factory
 * builds its sessions over that slot, so a service constructed beside it would
 * not see its sessions' rebuilds.
 */
function buildService(
   slowUpdateWarnMs?: number,
   logName?: string
): {
   service: DelayedModelService<FakeRoot>;
   session: ClientSession<FakeRoot>;
   lines: AttributedLine[];
} {
   const { logger, lines } = makeAttributingLogger();
   const clock = makeFakeClock();
   const bundle = makeTestServices<FakeRoot>({
      clock,
      logger,
      seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
      modelService: services => new DelayedModelService<FakeRoot>(services),
      clientSessionFactoryOptions: { slowUpdateWarnMs, logName }
   });
   const service = bundle.modelService as DelayedModelService<FakeRoot>;
   return { service, session: openSession(service, bundle.textDocuments, 'test-client'), lines };
}

// Passing `model` as a string bypasses the framework's `serialize` path
// (which reads from `services.ServiceRegistry`, absent from the test
// bundle) — the slow-warn test only needs the update path to run, not
// to actually serialise.
const updateArgs = { uri: URI_A, model: 'name: a\n', baseVersion: 'any' as const };

describe('ModelService readiness gate', () => {
   /**
    * `ready` must follow the workspace manager's POST-BUILD gate, not Langium's
    * `WorkspaceManager.ready`. Langium resolves the latter inside
    * `performStartup` — documents created, but before `documentBuilder.build`
    * runs — so a caller gating a write on it lands that write mid-initial-build.
    * That cancels the initial build, and the cancelled build's non-validating
    * options are then inherited by the write's own build, so cross-document
    * dependents are marked completed having never been validated.
    *
    * The stub gives Langium's `ready` an ALREADY-RESOLVED promise and holds
    * `workspaceInitialized` pending, so the two gates are distinguishable: only
    * a `ready` that follows the wrong one resolves early.
    */
   function makeGatedServices(ready: Promise<void>, workspaceInitialized: Promise<unknown>): ServerSharedServices {
      return makeNoopSharedServices<ServerSharedServices>({
         workspace: {
            DocumentBuilder: { onDocumentPhase: () => ({ dispose: () => undefined }) },
            WorkspaceManager: { ready, workspaceInitialized }
         }
      });
   }

   it('does not resolve until the initial workspace build completes', async () => {
      let buildDone = false;
      let finishBuild: () => void = () => undefined;
      const workspaceInitialized = new Promise<void>(resolve => {
         finishBuild = () => {
            buildDone = true;
            resolve();
         };
      });
      const service = new DefaultModelService<FakeRoot>(makeGatedServices(Promise.resolve(), workspaceInitialized));

      let readyResolved = false;
      void service.ready.then(() => {
         readyResolved = true;
      });
      // A macrotask turn flushes every pending microtask, so an already-resolved
      // Langium `ready` would have propagated by now. Asserting an ABSENCE, so
      // the wait has to outlast the thing it denies rather than sample beside it.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(readyResolved).toBe(false);

      finishBuild();
      await service.ready;
      expect(buildDone).toBe(true);
   });

   /**
    * `workspaceInitialized` rejects on a cancelled initial build (routine — any
    * write preempts one) and on a failed one. Langium's `ready`, which this gate
    * replaced, could not reject at all, so propagating would turn a timing fix
    * into a permanent failure: every later `waitForReady` rejects for the rest of
    * the process lifetime. "Connection is disposed" at teardown is the rejection
    * that surfaces this in practice.
    */
   it('resolves rather than rejecting when the initial build fails', async () => {
      const service = new DefaultModelService<FakeRoot>(
         makeGatedServices(Promise.resolve(), Promise.reject(new Error('Connection is disposed.')))
      );
      await expect(service.ready).resolves.toBeUndefined();
   });
});

describe('ModelService slow-warn', () => {
   it('emits no warn line when `slowUpdateWarnMs` is undefined (default)', async () => {
      const { service, session, lines } = buildService(undefined);
      service.setDelay(10);
      await session.update(updateArgs);
      expect(lines.filter(line => line.level === 'warn')).toEqual([]);
   });

   it('emits a warn line when elapsed exceeds the configured threshold', async () => {
      const { service, session, lines } = buildService(5);
      service.setDelay(20);
      await session.update(updateArgs);
      const warns = lines.filter(line => line.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toMatch(/Slow update: \d+ms ≥ 5ms/);
      expect(warns[0].message).toContain('client=test-client');
   });

   it('logs under the ClientSession tracer, with the client id in a bracket of its own', async () => {
      const { service, session, lines } = buildService(5);
      service.setDelay(20);
      await session.update(updateArgs);
      const warn = lines.find(line => line.level === 'warn');
      expect(warn?.component).toMatch(/^ClientSession\] \[test-client(\]|$)/);
   });

   it("logs under the factory's logName when one is set", async () => {
      const { service, session, lines } = buildService(5, 'Sessions');
      service.setDelay(20);
      await session.update(updateArgs);
      const warn = lines.find(line => line.level === 'warn');
      expect(warn?.component).toMatch(/^Sessions\] \[test-client(\]|$)/);
   });

   it('warns on every update at a threshold of 0, which is set rather than off', async () => {
      const { session, lines } = buildService(0);
      await session.update(updateArgs);
      const warns = lines.filter(line => line.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toMatch(/Slow update: \d+ms ≥ 0ms/);
   });

   it('does not warn when elapsed is below the configured threshold', async () => {
      const { session, lines } = buildService(10_000);
      // No delay — update should complete in single-digit milliseconds.
      await session.update(updateArgs);
      expect(lines.filter(line => line.level === 'warn')).toEqual([]);
   });

   it('does not double-emit on the cancel path (warn fires once per update)', async () => {
      const { service, session, lines } = buildService(5);
      service.setDelay(20);
      await session.update(updateArgs);
      await session.update(updateArgs);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(2);
   });
});

describe('ModelService createSession', () => {
   it('registers the id before it calls the factory, so a duplicate id builds no session', () => {
      const bundle = makeTestServices<FakeRoot>();
      bundle.modelService.createSession('test', 'client-1');
      const create = vi.spyOn(bundle.services.model.ClientSessionFactory, 'create');
      expect(() => bundle.modelService.createSession('test', 'client-1')).toThrow(DuplicateClientIdError);
      expect(create).not.toHaveBeenCalled();
   });
});

describe('ModelService update profiling', () => {
   afterEach(() => {
      Logger.setLevel('info');
      vi.restoreAllMocks();
   });

   it('emits a per-stage profile breakdown of the update chain at debug level', async () => {
      const { session, lines } = buildService(undefined);
      Logger.setLevel('debug');

      await session.update(updateArgs);

      const profileLines = lines.filter(line => line.message.includes('[profile model-update')).map(line => line.message);
      expect(profileLines.some(message => message.includes('serialize'))).toBe(true);
      expect(profileLines.some(message => message.includes('apply'))).toBe(true);
      expect(profileLines.some(message => message.includes('rebuild'))).toBe(true);
   });

   it('opens no profile session at the default info level', async () => {
      const { session, lines } = buildService(undefined);
      const profileSpy = vi.spyOn(DefaultTracer.prototype, 'profile');

      await session.update(updateArgs);

      // The ALLOCATION, not the output. Two neighbouring mechanisms already
      // suppress the lines — the session re-checks the level in `report`, and
      // AbstractLogger drops a below-threshold send — so an empty line filter is
      // produced whether or not the debug gate ran, and cannot witness the
      // per-update ProfileSession the gate exists to avoid.
      expect(profileSpy).not.toHaveBeenCalled();
      expect(lines.filter(line => line.message.includes('[profile'))).toHaveLength(0);
   });
});

/**
 * Bundle suited to the conflict-gating tests below: the document is
 * seeded into both LangiumDocuments (so `waitForDocumentState` can read
 * a fake document back) and TextDocuments (so `version(uri)` returns a
 * meaningful current version to compare against the caller's base
 * version), open for the session `editor-1`. The service keeps the default
 * `rebuild`: the gate sits ahead of the build pipeline, so no delayed rebuild
 * is needed.
 */
function buildConflictBundle(currentVersion = 1): {
   bundle: ReturnType<typeof makeTestServices<FakeRoot>>;
   service: ModelService<FakeRoot>;
   session: ClientSession<FakeRoot>;
} {
   const bundle = makeTestServices<FakeRoot>({
      serialize: (_uri, root) => `name:${(root as unknown as FakeRoot).name}`,
      seedDocuments: [
         {
            uri: URI_A,
            root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }),
            options: { version: currentVersion, text: `v${currentVersion}` }
         }
      ]
   });
   const session = openSession(bundle.modelService, bundle.textDocuments, 'editor-1', `v${currentVersion}`);
   // `seedOpen` always seeds at v1; bump by issuing change notifications
   // until the stub reaches `currentVersion`.
   for (let next = 2; next <= currentVersion; next++) {
      bundle.textDocuments.notifyDidChangeTextDocument(
         { textDocument: { uri: URI_A, version: next }, contentChanges: [{ text: `v${next}` }] },
         'editor-1'
      );
   }
   return { bundle, service: bundle.modelService, session };
}

describe('ModelService conflict gating', () => {
   it('throws ConflictError when args.baseVersion is stale relative to the current text-document version', async () => {
      const { session } = buildConflictBundle(3);
      const staleArgs = { uri: URI_A, model: 'name:newer\n', baseVersion: asModelVersion(2) };
      let captured: unknown;
      try {
         await session.update(staleArgs);
      } catch (error) {
         captured = error;
      }
      expect(isConflictError(captured)).toBe(true);
      const err = captured as ConflictError;
      expect(err.uri).toBe(URI_A);
      expect(err.baseVersion).toBe(2);
      expect(err.actualVersion).toBe(3);
   });

   it('refuses a write to a URI no client has open, and creates nothing', async () => {
      const { bundle, session } = buildConflictBundle(3);
      const coldUri = 'file:///never-seen.fake';

      await expect(session.update({ uri: coldUri, model: 'name:cold\n', baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect(bundle.textDocuments.get(coldUri)).toBeUndefined();
      expect(bundle.astDocumentManager.isOpen(coldUri)).toBe(false);
   });

   it("does not gate when args.baseVersion is 'any'", async () => {
      const { bundle, session } = buildConflictBundle(3);
      await session.update({ uri: URI_A, model: 'name:newer\n', baseVersion: 'any' });
      // The update applied — text-document changes recorded.
      expect(bundle.textDocuments.changes.find(change => change.text === 'name:newer\n')).toBeDefined();
   });

   it('proceeds when args.baseVersion matches the current text-document version, returning the post-build AST envelope', async () => {
      const { bundle, session } = buildConflictBundle(3);
      const doc = await session.update({ uri: URI_A, model: 'name:matched\n', baseVersion: asModelVersion(3) });
      // Text-document store records the bumped version (3 → 4) — the stub
      // `AstDocumentManager.update` increments by one. The stub fixture's Langium
      // doc is not rebuilt by text-document changes, so the returned envelope's
      // `version` says nothing here; assert on `TextDocuments.version` instead.
      expect(bundle.textDocuments.changes.find(change => change.text === 'name:matched\n')).toBeDefined();
      expect(bundle.textDocuments.version(URI_A)).toBe(4);
      expect(doc.uri).toBe(URI_A);
      expect(typeof doc.version).toBe('number');
   });

   it('save() gates on the same base version (delegates to update)', async () => {
      const { session } = buildConflictBundle(3);
      await expect(session.save({ uri: URI_A, model: 'name:newer\n', baseVersion: asModelVersion(1) })).rejects.toBeInstanceOf(
         ConflictError
      );
   });
});

describe('ModelService conflict gating under concurrency', () => {
   const appliedTexts = (bundle: ReturnType<typeof makeTestServices<FakeRoot>>): string[] =>
      bundle.textDocuments.changes.map(change => change.text).filter(text => text.startsWith('name:'));

   it('rejects the second of two same-version updates with the stock service and a string payload', async () => {
      const { bundle, service, session } = buildConflictBundle(3);
      const other = openSession(service, bundle.textDocuments, 'editor-2');
      const results = await Promise.allSettled([
         session.update({ uri: URI_A, model: 'name:first\n', baseVersion: asModelVersion(3) }),
         other.update({ uri: URI_A, model: 'name:second\n', baseVersion: asModelVersion(3) })
      ]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
      expect(appliedTexts(bundle)).toEqual(['name:first\n']);
   });
});

describe('ModelService AST envelopes', () => {
   it('waitForDocumentState returns an AstDocument that carries the text-document version', async () => {
      const { bundle, service } = buildConflictBundle(7);
      // The root as a factory parse of the seed at v7 would record it.
      bundle.modelLedger.record(bundle.documents.getDocument(UriUtils.toUri(URI_A))!.parseResult.value, 7);
      const doc = await service.waitForDocumentState(URI_A, DocumentState.Validated);
      expect(doc.version).toBe(7);
      void bundle; // bundle currently unused beyond seeding
   });
});

describe('ModelService diagnostics per read', () => {
   /** A document already carried to `Validated`, with the diagnostics that phase produced. */
   function validatedBundle(): ReturnType<typeof makeTestServices<FakeRoot>> {
      return makeTestServices<FakeRoot>({
         seedDocuments: [
            {
               uri: URI_A,
               root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }),
               options: {
                  state: DocumentState.Validated,
                  diagnostics: [
                     {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                        message: 'broken',
                        severity: DiagnosticSeverity.Error
                     }
                  ]
               }
            }
         ]
      });
   }

   it('settled() reports none even when the document was already carried past Validated', async () => {
      // The gap the `never` used to only claim: the wait resolves at or ABOVE
      // the phase asked for, so this document satisfies a settled() wait while
      // holding a full array. Any host that validates its workspace before a
      // consumer asks produces exactly this state.
      const bundle = validatedBundle();

      const document = await bundle.modelService.settled(URI_A);

      expect(document.diagnostics).toBeUndefined();
   });

   it('validated() reports them, so the absence above is the read and not the fixture', async () => {
      // Without this, the assertion above is equally satisfied by diagnostics
      // that never arrived — the same observation for the opposite reason.
      const bundle = validatedBundle();

      const document = await bundle.modelService.validated(URI_A);

      expect(document.diagnostics).toHaveLength(1);
   });

   it('a wait for Linked reports none on a document validated before', async () => {
      const bundle = validatedBundle();

      const document = await bundle.modelService.waitForDocumentState(URI_A, DocumentState.Linked);

      expect('diagnostics' in document).toBe(false);
   });

   it('snapshot() reports them for a validated document', () => {
      const bundle = validatedBundle();

      expect(bundle.modelService.snapshot(URI_A)?.diagnostics).toHaveLength(1);
   });

   it('snapshot() reports none below Validated, where the array is from an earlier build', () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [
            {
               uri: URI_A,
               root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }),
               options: {
                  state: DocumentState.IndexedReferences,
                  diagnostics: [
                     {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                        message: 'stale',
                        severity: DiagnosticSeverity.Error
                     }
                  ]
               }
            }
         ]
      });

      const snapshot = bundle.modelService.snapshot(URI_A);
      expect(snapshot && 'diagnostics' in snapshot).toBe(false);
   });
});

describe('ModelService.getDocument', () => {
   it('returns the built document for a URI (the canonicalizing gateway over LangiumDocuments)', () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      expect(bundle.modelService.getDocument(URI_A)?.uri.toString()).toBe(URI_A);
   });

   it('returns undefined for a URI with no registered document', () => {
      const bundle = makeTestServices<FakeRoot>();
      expect(bundle.modelService.getDocument('file:///nope.fake')).toBeUndefined();
   });
});

describe('ModelService symlink / canonical-URI divergence', () => {
   // The request path takes an external (client-facing) URI; the adopter's
   // `LangiumDocuments` keys by the resolved real path. The service must
   // canonicalize before looking the document up, or a symlinked URI resolves
   // to an empty envelope / a needless cold rebuild.
   const REAL_URI = 'file:///real/A.fake';
   const LINK_URI = 'file:///link/A.fake';
   const linkAware: DocumentUriPolicy = {
      canonicalUri: uri => {
         const text = typeof uri === 'string' ? uri : uri.toString();
         return UriUtils.normalize(text === LINK_URI ? REAL_URI : text) as CanonicalUri;
      },
      loadUri: uri => {
         const text = typeof uri === 'string' ? uri : uri.toString();
         return UriUtils.toUri(text === LINK_URI ? REAL_URI : text);
      }
   };

   it('waitForDocumentState resolves a symlink URI to the real document', async () => {
      const bundle = makeTestServices<FakeRoot>({
         documentUriPolicy: linkAware,
         seedDocuments: [{ uri: REAL_URI, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), options: { version: 7 } }]
      });
      bundle.modelLedger.record(bundle.documents.getDocument(UriUtils.toUri(REAL_URI))!.parseResult.value, 7);
      const service = new DefaultModelService<FakeRoot>(bundle.services);
      const doc = await service.waitForDocumentState(LINK_URI, DocumentState.Validated);
      expect(doc.version).toBe(7);
   });

   it('ensureDocumentState takes the warm path for a symlink URI of an already-loaded document', async () => {
      const bundle = makeTestServices<FakeRoot>({
         documentUriPolicy: linkAware,
         seedDocuments: [{ uri: REAL_URI, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const service = new DefaultModelService<FakeRoot>(bundle.services);
      await service.ensureDocumentState(LINK_URI, DocumentState.Validated);
      // hasDocument(canonical=REAL) is true → warm branch, no cold rebuild.
      expect(bundle.documentBuilder.updateCalls).toEqual([]);
      expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
   });
});

describe('ModelService ensureDocumentState dispatch', () => {
   it('warm path (URI already loaded) waits without triggering a build', async () => {
      // Seeding the URI makes `LangiumDocuments.hasDocument` true → warm branch.
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      await bundle.modelService.ensureDocumentState(URI_A, DocumentState.Validated);
      expect(bundle.documentBuilder.updateCalls).toEqual([]);
      expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
      expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(DocumentState.Validated);
   });

   it('cold path (URI absent) triggers one update([uri], []) then waits', async () => {
      // No seedDocuments → `hasDocument` false → cold branch via `rebuild`.
      const bundle = makeTestServices<FakeRoot>();
      await bundle.modelService.ensureDocumentState(URI_A, DocumentState.Validated);
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
      expect(bundle.documentBuilder.updateCalls[0].args[0].map(uri => uri.toString())).toEqual([URI_A]);
      expect(bundle.documentBuilder.updateCalls[0].args[1]).toEqual([]);
      expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
      expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(DocumentState.Validated);
   });

   it('defaults the wait state to the integrity-settled landmark when no state is passed', async () => {
      // Warm path (URI seeded) isolates the assertion to the state defaulting,
      // not the dispatch branch. The default is IntegrityService.SettledState
      // (= IndexedReferences) — no adopter-configurable targetPhase hook.
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      await bundle.modelService.ensureDocumentState(URI_A);
      expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
      expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(IntegrityService.SettledState);
   });
});

describe('ModelService write-lock reentrancy detection', () => {
   // `WorkspaceLock` is not reentrant: acquiring the write lock cancels the
   // running holder, so a facade write reached from inside a build cancels its
   // own enclosing build and then likely stalls in the phase wait. These pin the
   // detection that turns that silent stall into a named error.
   afterEach(() => setWriteLockScope(undefined));

   it('rejects a rebuild reached from inside a write-lock holder', async () => {
      setWriteLockScope(nodeWriteLockScope);
      const bundle = makeTestServices<FakeRoot>();

      // Driven THROUGH the real lock rather than by calling the scope helper
      // directly, so this also proves the binding is live end to end: the
      // services tree's lock is the framework subclass that marks the scope.
      let rejection: unknown;
      await bundle.services.workspace.WorkspaceLock.write(async () => {
         rejection = await bundle.modelService.rebuild(URI_A).then(
            () => undefined,
            (err: unknown) => err
         );
      });

      expect(rejection).toBeInstanceOf(ReentrantWriteLockError);
      expect((rejection as ReentrantWriteLockError).uri).toBe(URI_A);
      // The build never ran — that is the point, since running it is what would
      // have cancelled the enclosing one.
      expect(bundle.documentBuilder.updateCalls).toEqual([]);
   });

   it.each(['update', 'updateAll'] as const)(
      'refuses a session %s from inside a write-lock holder before applying its text',
      async method => {
         setWriteLockScope(nodeWriteLockScope);
         const bundle = makeTestServices<FakeRoot>();
         const session = openSession(bundle.modelService, bundle.textDocuments, 'client-1');
         const args = { uri: URI_A, model: 'name: b\n', baseVersion: 'any' as const };

         let rejection: unknown;
         await bundle.services.workspace.WorkspaceLock.write(async () => {
            const writing = method === 'update' ? session.update(args) : session.updateAll({ updates: [args] });
            rejection = await writing.then(
               () => undefined,
               (err: unknown) => err
            );
         });

         expect({ refused: rejection instanceof ReentrantWriteLockError, text: bundle.textDocuments.get(URI_A)?.getText() }).toEqual({
            refused: true,
            text: 'name: a\n'
         });
      }
   );

   it('allows the same rebuild from outside a write-lock holder', async () => {
      // The control that makes the rejection above meaningful: without it, a
      // guard that rejected unconditionally would pass that test too.
      setWriteLockScope(nodeWriteLockScope);
      const bundle = makeTestServices<FakeRoot>();
      await expect(bundle.modelService.rebuild(URI_A)).resolves.toBeDefined();
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
   });

   it('builds a reentrant rebuild without the lock under allowReentrantBuilds', async () => {
      // Completing at all is the assertion: a build that took the lock here
      // would wait for the holder it runs inside.
      setWriteLockScope(nodeWriteLockScope);
      const bundle = makeTestServices<FakeRoot>({ modelServiceOptions: { allowReentrantBuilds: true } });
      await bundle.services.workspace.WorkspaceLock.write(async () => {
         await bundle.modelService.rebuild(URI_A);
      });
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
   });

   /** Hold `lock` from outside any caller under test, until `release` is called. */
   async function holdLock(lock: WorkspaceLock): Promise<{ release(): void; held: Promise<void> }> {
      let release!: () => void;
      let started!: () => void;
      const running = new Promise<void>(resolve => (started = resolve));
      const held = lock.write(() => {
         started();
         return new Promise<void>(resolve => (release = resolve));
      });
      await running;
      return { release, held };
   }

   it('takes the lock for a rebuild from outside a holder under allowReentrantBuilds', async () => {
      // Unlocked, this build could overlap another build of the same document,
      // and the opt-in exists for the reentrant caller only.
      setWriteLockScope(nodeWriteLockScope);
      const bundle = makeTestServices<FakeRoot>({ modelServiceOptions: { allowReentrantBuilds: true } });
      const { release, held } = await holdLock(bundle.services.workspace.WorkspaceLock);

      const rebuilt = bundle.modelService.rebuild(URI_A);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(bundle.documentBuilder.updateCalls).toEqual([]);

      release();
      await held;
      await expect(rebuilt).resolves.toBeDefined();
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
   });

   it('builds without the lock every time under allowReentrantBuilds when no tracker is installed', async () => {
      // A reentrant caller cannot be told from any other without a tracker, so
      // locking here would deadlock the caller the opt-in exists for.
      setWriteLockScope(undefined);
      const bundle = makeTestServices<FakeRoot>({ modelServiceOptions: { allowReentrantBuilds: true } });
      const { release, held } = await holdLock(bundle.services.workspace.WorkspaceLock);

      await expect(bundle.modelService.rebuild(URI_A)).resolves.toBeDefined();
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);

      release();
      await held;
   });

   it('deadlocks without a tracker, which is the failure the detection replaces', async () => {
      // The measured justification for the whole mechanism, and for throwing
      // rather than warning: with no tracker installed the reentrant call is
      // NOT merely slower, it never completes. The inner `write` waits for the
      // outer holder to release while the outer waits for the inner call, so
      // both hang. A host without async-context support (a browser bundle)
      // keeps exactly this behaviour — the degradation is a missing rejection,
      // not a new failure, and the lock logs the stall instead.
      setWriteLockScope(undefined);
      const bundle = makeTestServices<FakeRoot>();
      let settled = false;
      // Deliberately not awaited — awaiting it is what hangs.
      void bundle.services.workspace.WorkspaceLock.write(async () => {
         await bundle.modelService.rebuild(URI_A);
         settled = true;
      }).catch(() => undefined);

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(settled).toBe(false);
   });
});

/**
 * Pins the post-build supersession log line emitted by the default
 * `update`. After applying the text (returning `appliedVersion`) and
 * awaiting `rebuild`, `update` reads `finalVersion = TextDocuments.version(uri)`
 * and logs "ready" when `finalVersion <= appliedVersion`, or
 * "ready at vN (changed again before it settled)" when a concurrent write or
 * an integrity repair advanced the version past `appliedVersion` before this
 * update settled. Pure observability — resolution is read-latest, so the
 * promise still resolves either way.
 *
 * The lines are `debug`-level; `AbstractLogger.send` drops anything above
 * the process-global threshold (default `info`), so each test raises the
 * threshold to `debug` and restores it in `finally`.
 */
describe('ModelService update supersession', () => {
   function buildSupersessionService(): {
      session: ClientSession<FakeRoot>;
      lines: CapturedLine[];
      bundle: ReturnType<typeof makeTestServices<FakeRoot>>;
   } {
      const { logger, lines } = makeCapturingLogger();
      const bundle = makeTestServices<FakeRoot>({
         logger,
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), options: { version: 1 } }],
         modelService: services => new DefaultModelService<FakeRoot>(services)
      });
      // Current text-doc version = 1, matching `args.baseVersion` at v1 so the
      // conflict gate stays inert; `AstDocumentManager.update` then bumps
      // to v2, making `appliedVersion = 2`.
      const session = openSession(bundle.modelService, bundle.textDocuments, 'editor-1', 'v1');
      return { session, lines, bundle };
   }

   const supersessionLines = (lines: CapturedLine[]): CapturedLine[] => lines.filter(line => /Update to v\d+ ready/.test(line.message));

   it('logs "ready" without a suffix when no newer version overtakes', async () => {
      const { session, lines } = buildSupersessionService();
      const previous = Logger.getLevel();
      Logger.setLevel('debug');
      try {
         await session.update({ uri: URI_A, model: 'a', baseVersion: asModelVersion(1) });
         const ready = supersessionLines(lines);
         expect(ready).toHaveLength(1);
         expect(ready[0].message).toMatch(/Update to v\d+ ready$/);
         expect(ready[0].message).not.toContain('changed again');
      } finally {
         Logger.setLevel(previous);
      }
   });

   it('logs "ready at vN (changed again before it settled)" yet still resolves when a newer version overtakes', async () => {
      const { session, lines, bundle } = buildSupersessionService();
      const previous = Logger.getLevel();
      Logger.setLevel('debug');
      try {
         // Hold the NEXT waitUntil — update #1's rebuild — so a concurrent
         // writer can overtake the version before update #1 settles.
         const gate = bundle.documentBuilder.gateNextWaitUntil();
         const inFlight = session.update({ uri: URI_A, model: 'a', baseVersion: asModelVersion(1) });
         // Spin the microtask queue until update #1 has driven its await chain
         // (apply text → rebuild's DocumentBuilder.update → Logger.time)
         // all the way to the gated `waitUntil`. A fixed tick count is fragile —
         // the chain is several awaits deep, so a too-low count releases the gate
         // before `waitUntil` reassigns its resolver and the update would hang on
         // a placeholder. Gate the loop on the observable `waitUntilCalls` instead.
         for (let tick = 0; tick < 100 && bundle.documentBuilder.waitUntilCalls.length === 0; tick++) {
            await Promise.resolve();
         }
         expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
         // A concurrent writer advances the text-doc version past appliedVersion(2).
         bundle.textDocuments.notifyDidChangeTextDocument(
            { textDocument: { uri: URI_A, version: 3 }, contentChanges: [{ text: 'b' }] },
            'editor-2'
         );
         gate.resolve();
         const doc = await inFlight;
         // Read-latest: the promise resolves rather than hanging for v2's
         // specific settled event.
         expect(doc).toBeDefined();
         const ready = supersessionLines(lines);
         expect(ready).toHaveLength(1);
         expect(ready[0].message).toMatch(/Update to v2 ready at v3 \(changed again before it settled\)$/);
      } finally {
         Logger.setLevel(previous);
      }
   });
});

describe('ModelService rebuild and save', () => {
   it('rebuild issues update([uri], []) even when the document is already loaded', async () => {
      // Seeding the URI makes it loaded; `rebuild` builds unconditionally
      // (contrast with `ensureDocumentState`, which skips the build when warm).
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      await bundle.modelService.rebuild(URI_A);
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
      expect(bundle.documentBuilder.updateCalls[0].args[0].map(uri => uri.toString())).toEqual([URI_A]);
      expect(bundle.documentBuilder.updateCalls[0].args[1]).toEqual([]);
      expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
      // No explicit state → defaults to the integrity-settled landmark.
      expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(IntegrityService.SettledState);
   });

   it('rebuild waits at the explicit phase when one is given', async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      await bundle.modelService.rebuild(URI_A, DocumentState.Parsed);
      expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
      expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(DocumentState.Parsed);
   });

   it('save applies the text via update then persists and records the save', async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const session = openSession(bundle.modelService, bundle.textDocuments, 'editor-1');
      // Pass `model` as a string to bypass the rewrite + serialize path; no
      // `version` so the conflict gate is inert (covered elsewhere).
      const saved = await session.save({ uri: URI_A, model: 'name: saved\n', baseVersion: 'any' });
      expect(saved.persisted.version).toBe(bundle.textDocuments.version(URI_A));
      // update applied the new text...
      const change = bundle.textDocuments.changes.find(entry => entry.text === 'name: saved\n');
      expect(change).toBeDefined();
      // ...then save persisted through the file system and recorded the save.
      expect(bundle.fileSystem.writes.map(write => write.uri)).toContain(URI_A);
      expect(bundle.textDocuments.saves).toContainEqual({ uri: URI_A, clientId: 'editor-1' });
   });

   it('save based on a numbered version persists the text its own update wrote', async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const session = openSession(bundle.modelService, bundle.textDocuments, 'editor-1');

      await session.save({ uri: URI_A, model: 'name: saved\n', baseVersion: asModelVersion(bundle.textDocuments.version(URI_A)) });

      expect(bundle.fileSystem.writes).toContainEqual({ uri: URI_A, content: 'name: saved\n' });
   });

   it('persist answers once the text is written, even when the build after it is given up', async () => {
      class GivenUpModelService extends DefaultModelService<FakeRoot> {
         override ensureDocumentState(): Promise<never> {
            return Promise.reject(new Error('build given up'));
         }
      }
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
         modelService: services => new GivenUpModelService(services)
      });
      const session = openSession(bundle.modelService, bundle.textDocuments, 'editor-1');

      await expect(session.persist({ uri: URI_A, baseVersion: 'any' })).resolves.toBe(bundle.textDocuments.version(URI_A));
      expect(bundle.fileSystem.writes.map(write => write.uri)).toContain(URI_A);
   });

   it("persist writes another session's text as it is, under this session, without an update", async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const writer = openSession(bundle.modelService, bundle.textDocuments, 'editor-2');
      const persister = openSession(bundle.modelService, bundle.textDocuments, 'editor-1');
      await writer.update({ uri: URI_A, model: 'name:   spaced\n\n', baseVersion: 'any' });
      const changes = bundle.textDocuments.changes.length;

      await persister.persist({ uri: URI_A, baseVersion: asModelVersion(bundle.textDocuments.version(URI_A)) });

      expect(bundle.fileSystem.writes).toContainEqual({ uri: URI_A, content: 'name:   spaced\n\n' });
      expect(bundle.textDocuments.saves).toContainEqual({ uri: URI_A, clientId: 'editor-1' });
      expect(bundle.textDocuments.changes).toHaveLength(changes);
   });

   it('persist reports the version of the text it wrote, not of a write that landed during the write', async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const writer = openSession(bundle.modelService, bundle.textDocuments, 'editor-2');
      const persister = openSession(bundle.modelService, bundle.textDocuments, 'editor-1');
      const taken = bundle.textDocuments.version(URI_A);
      let release = (): void => undefined;
      const writing = new Promise<void>(resolve => (release = resolve));
      const writeFile = bundle.fileSystem.writeFile.bind(bundle.fileSystem);
      bundle.fileSystem.writeFile = async (uri, content) => {
         await writing;
         return writeFile(uri, content);
      };

      const persisting = persister.persist({ uri: URI_A, baseVersion: asModelVersion(taken) });
      await writer.update({ uri: URI_A, model: 'name:later\n', baseVersion: 'any' });
      release();
      const persisted = await persisting;

      expect(bundle.textDocuments.version(URI_A)).toBeGreaterThan(taken);
      expect(persisted).toBe(taken);
   });

   it('save and persist report the version the manager wrote, which a coalesced save takes from a newer one', async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const session = openSession(bundle.modelService, bundle.textDocuments, 'editor-1');
      const written = asModelVersion(bundle.textDocuments.version(URI_A) + 5);
      const save = bundle.astDocumentManager.save.bind(bundle.astDocumentManager);
      bundle.astDocumentManager.save = async (uri, clientId) => {
         await save(uri, clientId);
         return written;
      };

      const persisted = await session.persist({ uri: URI_A, baseVersion: 'any' });
      const saved = await session.save({ uri: URI_A, model: 'name: saved\n', baseVersion: 'any' });

      expect(persisted).toBe(written);
      expect(saved.persisted.version).toBe(written);
   });

   it('persist refuses a stale base version and writes nothing', async () => {
      const { bundle, session } = buildConflictBundle(3);
      await expect(session.persist({ uri: URI_A, baseVersion: asModelVersion(1) })).rejects.toBeInstanceOf(ConflictError);
      expect(bundle.fileSystem.writes).toEqual([]);
      expect(bundle.textDocuments.saves).toEqual([]);
   });

   it('persist refuses a document the session does not have open and writes nothing', async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      openSession(bundle.modelService, bundle.textDocuments, 'editor-2');
      const stranger = bundle.modelService.createSession('test', 'editor-1');
      await expect(stranger.persist({ uri: URI_A, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(bundle.fileSystem.writes).toEqual([]);
   });
});

/** Exposes the protected `settleSave` and the sync chain it drains. */
class SettlingModelService extends DefaultModelService<FakeRoot> {
   settle(uri: string): Promise<void> {
      return this.settleSave(uri);
   }

   holdSyncChain(uri: string, chain: Promise<void>): void {
      this.syncChains.set(uri, chain);
   }
}

function buildSettling(clock?: FakeClock): {
   bundle: ReturnType<typeof makeTestServices<FakeRoot>>;
   service: SettlingModelService;
   lines: AttributedLine[];
} {
   const { logger, lines } = makeAttributingLogger();
   const bundle = makeTestServices<FakeRoot>({
      clock,
      logger,
      seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
      modelService: services => new SettlingModelService(services)
   });
   return { bundle, service: bundle.modelService as SettlingModelService, lines };
}

const SETTLE_BOUND_MS = 10_000;

describe('ModelService settleSave', () => {
   afterEach(() => {
      vi.useRealTimers();
   });

   it('clears its bound once the save has settled', async () => {
      // On the system clock, so the platform's own timer count sees a bound
      // that is left scheduled after the race is won.
      vi.useFakeTimers();
      const { service } = buildSettling();
      const before = vi.getTimerCount();

      await service.settle(URI_A);

      expect(vi.getTimerCount()).toBe(before);
   });

   it('warns and returns once the bound passes on the service clock while the build hangs', async () => {
      const clock = makeFakeClock();
      const { bundle, service, lines } = buildSettling(clock);
      const gate = bundle.documentBuilder.gateNextWaitUntil();
      let settled = false;
      const settling = service.settle(URI_A).then(() => (settled = true));
      await waitFor(() => bundle.documentBuilder.waitUntilCalls.length === 1);

      clock.advance(SETTLE_BOUND_MS - 1);
      await tick(5);
      expect(settled).toBe(false);
      clock.advance(1);
      await settling;

      expect(lines.some(line => line.level === 'warn' && line.message.includes(`exceeded ${SETTLE_BOUND_MS}ms`))).toBe(true);
      gate.resolve();
   });

   it('bounds the build and the sync chain by one deadline, not one each', async () => {
      const clock = makeFakeClock();
      const { bundle, service, lines } = buildSettling(clock);
      const gate = bundle.documentBuilder.gateNextWaitUntil();
      service.holdSyncChain(UriUtils.toUri(URI_A).toString(), new Promise<void>(() => undefined));
      let settled = false;
      const settling = service.settle(URI_A).then(() => (settled = true));
      await waitFor(() => bundle.documentBuilder.waitUntilCalls.length === 1);

      clock.advance(SETTLE_BOUND_MS / 2);
      gate.resolve();
      await tick(5);
      expect(settled).toBe(false);
      clock.advance(SETTLE_BOUND_MS / 2);
      await settling;

      expect(lines.some(line => line.level === 'warn' && line.message.includes(`exceeded ${SETTLE_BOUND_MS}ms`))).toBe(true);
   });

   it('requests a sync build for a model behind its text', async () => {
      const clock = makeFakeClock();
      const { bundle, service } = buildSettling(clock);
      bundle.textDocuments.seedOpen(URI_A, 'name: a\n', 'editor-1');
      bundle.modelLedger.record(bundle.documents.getDocument(UriUtils.toUri(URI_A))!.parseResult.value, 0);
      const asked: Array<{ uri: string; version: number }> = [];
      bundle.services.workspace.VersionSyncService.syncTo = (uri, version) => {
         asked.push({ uri: uri.toString(), version });
         // Given up, so the settle returns without a parse to wait for.
         return Promise.resolve(false);
      };

      const settling = service.settle(URI_A);
      // A wait that requests nothing ends only at the bound.
      await tick();
      clock.advance(SETTLE_BOUND_MS);
      await settling;

      expect(asked).toEqual([{ uri: URI_A, version: 1 }]);
   });

   it('logs a wait that fails inside the bound apart from the timeout, and returns', async () => {
      const { service, lines } = buildSettling(makeFakeClock());
      const chain = Promise.reject(new Error('chain failed'));
      // Observed here, so the rejection is not reported before the settle reaches the chain.
      chain.catch(() => undefined);
      service.holdSyncChain(UriUtils.toUri(URI_A).toString(), chain);

      await service.settle(URI_A);

      const warnings = lines.filter(line => line.level === 'warn').map(line => line.message);
      expect(warnings.some(message => message.includes('failed before the timeout') && message.includes('chain failed'))).toBe(true);
      expect(warnings.some(message => message.includes('exceeded'))).toBe(false);
   });
});

/**
 * The LSP-client sync. One persistent
 * `onDocumentPhase(IntegrityService.SettledState)` listener mirrors server-side
 * changes of a document open in the language client back to it through a
 * coalesced `applyEditToLanguageClient`, routed by **content**: the shadow
 * no-ops the RPC when Monaco already matches, so a Monaco echo and a
 * cascade-unchanged doc both cost nothing. A document the language client does
 * not have open gets nothing. Integrity corrections need no special casing:
 * the corrected text lands in the synced store in place, so an open corrected
 * doc takes the same path. The listener re-derives from the settled state
 * every time, so it is self-healing.
 */
describe('ModelService LSP-client sync', () => {
   /** A settled-phase document carrying the post-build text. */
   function settledDoc(uri: string, text: string, version = 2): LangiumDocument {
      return { uri: { toString: () => uri }, textDocument: TextDocument.create(uri, 'fake', version, text) } as unknown as LangiumDocument;
   }

   /** Drain the coalesced applyEdit chain (one microtask-deep per pending entry). */
   async function drainSync(): Promise<void> {
      for (let tick = 0; tick < 10; tick++) {
         await Promise.resolve();
      }
   }

   /** Bundle whose document is open in the language client or, with `open: false`, in no client. */
   function buildSyncBundle(verdict: { open: boolean }): ReturnType<typeof makeTestServices<FakeRoot>> {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      // `syncToLanguageClient` routes on the text store's open-state predicate:
      // open in the language client → `applyEditToLanguageClient`. (The egress
      // translates the canonical key to the recorded client URI; presence is
      // all the routing needs.)
      if (verdict.open) {
         bundle.textDocuments.seedOpenInLanguageClient(URI_A);
      }
      return bundle;
   }

   it('applyEdits an open doc when it settles', async () => {
      const bundle = buildSyncBundle({ open: true });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => ({ uri: edit.uri, text: edit.text }))).toEqual([{ uri: URI_A, text: 'name:b' }]);
      expect(bundle.textDocuments.staged).toEqual([]);
   });

   it('applyEdits an open doc with integrity corrections, which ride this path', async () => {
      // The corrected text is in the store and the shadow decides delivery.
      const bundle = buildSyncBundle({ open: true });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:corrected'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => edit.text)).toEqual(['name:corrected']);
   });

   it('pushes and stages nothing for a document the language client does not have open', async () => {
      // Every write needs an open, so no client edit ever settles on a document
      // no client has open, and nothing is carried to a language client's next
      // open either.
      const bundle = buildSyncBundle({ open: false });
      // The store would drop the push too; the spy pins that no sync starts.
      const push = vi.spyOn(bundle.textDocuments, 'applyEditToLanguageClient');
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(push).not.toHaveBeenCalled();
      expect(bundle.textDocuments.staged).toEqual([]);
   });

   it('re-syncs on every settle (self-healing) — not a one-shot enrolment', async () => {
      const bundle = buildSyncBundle({ open: true });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      // A later settle of the same doc (re-open refresh / recovery build) re-syncs
      // the current text — the safety net the once-only enrolment lacked.
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:c', 3));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => edit.text)).toEqual(['name:b', 'name:c']);
   });

   /**
    * A rejected push is the version gate doing its job: the client's buffer moved
    * while the line-keyed diff was in flight, so applying it would splice the
    * file. Dropping the push there would leave the editor showing text the server
    * has superseded, with no guaranteed later settle to correct it — a
    * content-identical echo mints no rebuild. The rejection invalidates the
    * shadow, so the re-push is a full replace, which lands on any buffer.
    */
   it('re-pushes once when the language client rejects the versioned diff', async () => {
      const bundle = buildSyncBundle({ open: true });
      let calls = 0;
      bundle.textDocuments.setApplyEditHandler(() => ({ applied: ++calls > 1 }));
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => edit.text)).toEqual(['name:b', 'name:b']);
   });

   it('bounds the re-push at one, so a client that refuses everything does not spin', async () => {
      const bundle = buildSyncBundle({ open: true });
      bundle.textDocuments.setApplyEditHandler(() => ({ applied: false }));
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      // Absolute count, not a delta: the failure this stands against is an
      // unbounded loop, which any "more than before" assertion also satisfies.
      expect(bundle.textDocuments.appliedEdits).toHaveLength(2);
   });

   it('drops the re-push when a newer settle already superseded the rejected text', async () => {
      // A settle lands while the rejected push is in flight. Its text is what the
      // client must end up with, so re-pushing the rejected one would walk the
      // editor backwards — the observable failure being a third push,
      // `['name:b','name:c','name:b']`. That happens when the settle starts a
      // second, concurrent drain chain and the two pushes cannot see each
      // other's pending slot, which is the re-entrancy `queueSync` closes.
      const bundle = buildSyncBundle({ open: true });
      let calls = 0;
      bundle.textDocuments.setApplyEditHandler(() => {
         if (++calls === 1) {
            bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:c', 3));
            return { applied: false };
         }
         return { applied: true };
      });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => edit.text)).toEqual(['name:b', 'name:c']);
   });

   it('keys the outbound sync chain by the canonical URI under a symlink divergence', async () => {
      // The doc is built/keyed at its real path R but open in the language client
      // under a symlink path S. The coalescing chain (the URI `drainSyncQueue`
      // hands to `applyEditToLanguageClient`) must be keyed by the CANONICAL R — the same
      // key `settleSave` looks the chain up under — not S, or a save-settle returns
      // before the in-flight applyEdit drains. (Egress still reaches S: the real
      // text store fans out via the recorded language-client URIs.)
      const REAL = 'file:///real/x.fake';
      const LINK = 'file:///link/x.fake';
      const asText = (uri: string | { toString(): string }): string => (typeof uri === 'string' ? uri : uri.toString());
      const linkAware: DocumentUriPolicy = {
         canonicalUri: uri => UriUtils.normalize(asText(uri) === LINK ? REAL : asText(uri)) as CanonicalUri,
         loadUri: uri => UriUtils.toUri(asText(uri) === LINK ? REAL : asText(uri))
      };
      const bundle = makeTestServices<FakeRoot>({
         documentUriPolicy: linkAware,
         seedDocuments: [{ uri: REAL, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      // Open in the language client (the routing predicate canonicalizes, so the
      // canonical real path is what the store records as open). Egress to the
      // symlink path S is the real text store's job; here the stub records the
      // chain key, which must be the canonical R.
      bundle.textDocuments.seedOpenInLanguageClient(REAL);
      // The settled doc carries the canonical (real-path) URI off the build.
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(REAL, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => edit.uri)).toEqual([REAL]);
   });
});

/**
 * Pins the `modelToText` contract: a structured payload runs the
 * transfer-model rewrite chain then `serialize`; a pre-serialised string
 * payload bypasses both entirely (it's trusted to be final). The rewrite chain
 * is the single transfer-model-transform seam — its ordering/threading is
 * covered by `update-rewrite/update-rewrite-service.test.ts`; this stub leaves
 * the chain empty (the test harness binds no `updateRewrite` slot, so
 * `rewriteModel` degrades to identity), isolating the serialize-gating contract.
 */
class RecordingModelService extends DefaultModelService<FakeRoot, AstDiagnostic, FakeRoot> {
   constructor(
      services: ServerSharedServices,
      readonly order: string[]
   ) {
      super(services);
   }

   protected override serialize(_uri: string, _root: FakeRoot): string {
      this.order.push('serialize');
      return 'serialized';
   }
}

describe('ModelService modelToText serialize gating', () => {
   function buildRecordingService(): {
      session: ClientSession<FakeRoot, AstDiagnostic, FakeRoot>;
      order: string[];
   } {
      const order: string[] = [];
      const bundle = makeTestServices<FakeRoot, AstDiagnostic, FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
         modelService: services => new RecordingModelService(services, order)
      });
      return { session: openSession(bundle.modelService, bundle.textDocuments, 'editor-1'), order };
   }

   it('serialises a structured (object) payload', async () => {
      const { session, order } = buildRecordingService();
      // No `version` → conflict gate inert; the structured root drives the
      // `serialize(uri, rewriteModel(model))` branch of `modelToText`.
      await session.update({ uri: URI_A, model: { $type: 'FakeRoot', name: 'x' }, baseVersion: 'any' });
      expect(order).toEqual(['serialize']);
   });

   it('bypasses serialize for a pre-serialised string payload', async () => {
      const { session, order } = buildRecordingService();
      await session.update({ uri: URI_A, model: 'name: x\n', baseVersion: 'any' });
      expect(order).toEqual([]);
   });

   it.each(['update', 'updateAll'] as const)('runs no serializer for a %s of a document the session does not have open', async method => {
      // The serializer is the adopter's code and need not be side-effect free,
      // so a write the open check refuses must not reach it.
      const { session, order } = buildRecordingService();
      const model = { $type: 'FakeRoot', name: 'x' } as const;
      const unopened = 'file:///never-opened.fake';
      const write =
         method === 'update'
            ? session.update({ uri: unopened, model, baseVersion: 'any' })
            : session.updateAll({ updates: [{ uri: unopened, model, baseVersion: 'any' }] });

      await expect(write).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(order).toEqual([]);
   });
});

/**
 * Pins the per-state convenience methods. Each delegates to
 * `ensureDocumentState(uri, <phase>)`, so a warm call waits at exactly
 * the named phase. The phase mapping is read straight from production:
 * `settled` maps to the `IntegrityService.SettledState` constant (which
 * currently equals `IndexedReferences`) — the test imports the constant
 * rather than hardcoding the numeric value so it tracks a future move.
 *
 * The "earlier phases carry no diagnostics" guarantee is compile-time
 * only (the `AstDocument<TAst, never>` return type); at runtime the stub
 * may still surface a diagnostics array, so no runtime assertion on it.
 */
describe('ModelService per-state convenience methods', () => {
   /** Method name → phase it waits at. Typed so the index access stays safe. */
   type ConvenienceMethod = 'parsed' | 'linked' | 'settled' | 'indexed' | 'validated';
   const cases: ReadonlyArray<{ method: ConvenienceMethod; state: DocumentState }> = [
      { method: 'parsed', state: DocumentState.Parsed },
      { method: 'linked', state: DocumentState.Linked },
      { method: 'settled', state: IntegrityService.SettledState },
      { method: 'indexed', state: DocumentState.IndexedReferences },
      { method: 'validated', state: DocumentState.Validated }
   ];

   it.each(cases)('$method waits at its named phase (warm path)', async ({ method, state }) => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      await bundle.modelService[method](URI_A);
      expect(bundle.documentBuilder.waitUntilCalls).toHaveLength(1);
      expect(bundle.documentBuilder.waitUntilCalls[0].args[0]).toBe(state);
   });

   it('routes through the warm/cold dispatch — warm call skips the build', async () => {
      // Representative method (`validated`): seeding the URI makes the warm
      // branch fire, so no `DocumentBuilder.update` is issued.
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      await bundle.modelService.validated(URI_A);
      expect(bundle.documentBuilder.updateCalls).toEqual([]);
   });

   it('routes through the warm/cold dispatch — cold call triggers one build', async () => {
      // No seedDocuments → cold branch → one `DocumentBuilder.update([uri], [])`.
      const bundle = makeTestServices<FakeRoot>();
      await bundle.modelService.validated(URI_A);
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
   });
});

/**
 * Pins the slow-warn-gated stopwatch allocation in a session's `update`: a
 * stopwatch only when the factory's `slowUpdateWarnMs` is set.
 * When no threshold is configured the slow-warn path is dead, so the
 * stopwatch must NOT be allocated; when one is configured it must be.
 * Wraps the bound `Clock.stopwatch` to count allocations, so an
 * unconditional allocation shows up as a count rather than as no symptom.
 */
describe('ModelService update stopwatch allocation', () => {
   function buildCountingService(slowUpdateWarnMs?: number): {
      session: ClientSession<FakeRoot>;
      stopwatchCalls: () => number;
   } {
      const clock = makeFakeClock();
      let calls = 0;
      const realStopwatch = clock.stopwatch.bind(clock);
      clock.stopwatch = () => {
         calls++;
         return realStopwatch();
      };
      const bundle = makeTestServices<FakeRoot>({
         clock,
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
         modelService: services => new DelayedModelService<FakeRoot>(services),
         clientSessionFactoryOptions: { slowUpdateWarnMs }
      });
      return { session: openSession(bundle.modelService, bundle.textDocuments, 'test-client'), stopwatchCalls: () => calls };
   }

   it('does not allocate a stopwatch when slowUpdateWarnMs is undefined', async () => {
      const { session, stopwatchCalls } = buildCountingService(undefined);
      await session.update(updateArgs);
      expect(stopwatchCalls()).toBe(0);
   });

   it('allocates a stopwatch when slowUpdateWarnMs is configured', async () => {
      const { session, stopwatchCalls } = buildCountingService(5);
      await session.update(updateArgs);
      expect(stopwatchCalls()).toBe(1);
   });
});

describe('ModelService toAstDocument absent-document envelope', () => {
   it('returns an envelope carrying the uri, a version no write matches, and no diagnostics', async () => {
      // No seedDocuments → LangiumDocuments.getDocument returns undefined.
      const bundle = makeTestServices<FakeRoot>();
      const doc = await bundle.modelService.waitForDocumentState(URI_A, DocumentState.Validated);
      expect(doc).toStrictEqual({ uri: URI_A, version: UNRECORDED_VERSION, root: undefined });
   });
});
