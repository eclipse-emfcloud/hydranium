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
   ConflictError,
   Disposable as HydraniumDisposable,
   isConflictError,
   Logger,
   type OpenModelArgs,
   type Tracer,
   type TransferDiagnostic
} from '@hydranium/protocol';
import { type FakeClock, makeFakeClock } from '@hydranium/protocol/testing';
import { type AstNode, DocumentState, type LangiumDocument, UriUtils } from '@hydranium/langium';
import { type Disposable } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { IntegrityService } from '../../../src/langium/integrity/integrity-service.js';
import { DefaultModelService, type ModelService } from '../../../src/langium/model-service/model-service.js';
import { type ServerSharedServices } from '../../../src/langium/module.js';
import { type DocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import {
   type CapturedLine,
   makeCapturingLogger,
   makeFakeAstNode,
   makeNoopSharedServices,
   makeTestServices
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

   /**
    * The derived tracer the service actually calls. `Tracer.for` returns a NEW
    * instance, so a spy installed on the bundle's shared slot never sees the
    * service's own calls.
    */
   get boundTracer(): Tracer {
      return this.tracer;
   }

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

function buildService(slowUpdateWarnMs?: number): {
   service: DelayedModelService<FakeRoot>;
   lines: CapturedLine[];
} {
   const { logger, lines } = makeCapturingLogger();
   const clock = makeFakeClock();
   // Bind the capturing logger so the service's `Tracer.for('ModelService')`
   // derivation emits (timing + warn lines) into `lines`.
   const bundle = makeTestServices<FakeRoot>({
      clock,
      logger,
      seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
   });
   const service = new DelayedModelService<FakeRoot>(bundle.services, { slowUpdateWarnMs });
   return { service, lines };
}

// Passing `model` as a string bypasses the framework's `serialize` path
// (which reads from `services.ServiceRegistry`, absent from the test
// bundle) — the slow-warn test only needs the update path to run, not
// to actually serialise.
const updateArgs = { uri: URI_A, clientId: 'test-client', model: 'name: a\n' };

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
      const { service, lines } = buildService(undefined);
      service.setDelay(10);
      await service.update(updateArgs);
      expect(lines.filter(line => line.level === 'warn')).toEqual([]);
   });

   it('emits a warn line when elapsed exceeds the configured threshold', async () => {
      const { service, lines } = buildService(5);
      service.setDelay(20);
      await service.update(updateArgs);
      const warns = lines.filter(line => line.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toMatch(/Slow update: \d+ms ≥ 5ms/);
      expect(warns[0].message).toContain('client=test-client');
   });

   it('does not warn when elapsed is below the configured threshold', async () => {
      const { service, lines } = buildService(10_000);
      // No delay — update should complete in single-digit milliseconds.
      await service.update(updateArgs);
      expect(lines.filter(line => line.level === 'warn')).toEqual([]);
   });

   it('does not double-emit on the cancel path (warn fires once per update)', async () => {
      const { service, lines } = buildService(5);
      service.setDelay(20);
      await service.update(updateArgs);
      await service.update(updateArgs);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(2);
   });
});

describe('ModelService update profiling', () => {
   afterEach(() => Logger.setLevel('info'));

   it('emits a per-stage profile breakdown of the update chain at debug level', async () => {
      const { service, lines } = buildService(undefined);
      Logger.setLevel('debug');

      await service.update(updateArgs);

      const profileLines = lines.filter(line => line.message.includes('[profile model-update')).map(line => line.message);
      expect(profileLines.some(message => message.includes('serialize'))).toBe(true);
      expect(profileLines.some(message => message.includes('apply'))).toBe(true);
      expect(profileLines.some(message => message.includes('rebuild'))).toBe(true);
   });

   it('opens no profile session at the default info level', async () => {
      const { service, lines } = buildService(undefined);
      const profileSpy = vi.spyOn(service.boundTracer, 'profile');

      await service.update(updateArgs);

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
 * meaningful current version to compare against the caller's based-on
 * version). The service uses the default `rebuild` shape — the
 * gating-check sits ahead of the build pipeline so the delayed-rebuild
 * stub from the slow-warn tests isn't needed here.
 */
function buildConflictBundle(currentVersion = 1): {
   bundle: ReturnType<typeof makeTestServices<FakeRoot>>;
   service: ModelService<FakeRoot>;
} {
   const bundle = makeTestServices<FakeRoot>({
      serialize: (_uri, root) => `name:${(root as unknown as FakeRoot).name}`,
      seedDocuments: [
         { uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), options: { version: currentVersion } }
      ]
   });
   bundle.textDocuments.seedOpen(URI_A, `v${currentVersion}`, 'editor-1');
   // `seedOpen` always seeds at v1; bump by issuing change notifications
   // until the stub reaches `currentVersion`.
   for (let next = 2; next <= currentVersion; next++) {
      bundle.textDocuments.notifyDidChangeTextDocument(
         { textDocument: { uri: URI_A, version: next }, contentChanges: [{ text: `v${next}` }] },
         'editor-1'
      );
   }
   return { bundle, service: bundle.modelService };
}

describe('ModelService conflict gating', () => {
   it('throws ConflictError when args.baseVersion is stale relative to the current text-document version', async () => {
      const { service } = buildConflictBundle(3);
      const staleArgs = { uri: URI_A, clientId: 'editor-1', model: 'name:newer\n', baseVersion: 2 };
      let captured: unknown;
      try {
         await service.update(staleArgs);
      } catch (error) {
         captured = error;
      }
      expect(isConflictError(captured)).toBe(true);
      const err = captured as ConflictError;
      expect(err.uri).toBe(URI_A);
      expect(err.expectedVersion).toBe(2);
      expect(err.actualVersion).toBe(3);
   });

   it('throws ConflictError for a based-on write to a URI the store has never seen', async () => {
      // `update` is an upsert, so a cold URI is CREATED by this call — and a
      // caller claiming to have based it on v5 has based it on nothing. Every
      // other case here seeds an open document, so this is the only cover for
      // the cold branch. It is deliberately insensitive to WHERE the gate reads
      // its version: a cold URI answers 0 before the upsert's open and 0 after
      // it, which is why moving that read left this behaviour intact.
      const { service } = buildConflictBundle(3);
      const coldArgs = { uri: 'file:///never-seen.fake', clientId: 'editor-1', model: 'name:cold\n', baseVersion: 5 };
      let captured: unknown;
      try {
         await service.update(coldArgs);
      } catch (error) {
         captured = error;
      }
      expect(isConflictError(captured)).toBe(true);
      expect((captured as ConflictError).actualVersion).toBe(0);
   });

   it('does not gate when args.baseVersion is omitted', async () => {
      const { bundle, service } = buildConflictBundle(3);
      const noVersionArgs = { uri: URI_A, clientId: 'editor-1', model: 'name:newer\n' };
      await service.update(noVersionArgs);
      // The update applied — text-document changes recorded.
      expect(bundle.textDocuments.changes.find(change => change.text === 'name:newer\n')).toBeDefined();
   });

   it('proceeds when args.baseVersion matches the current text-document version, returning the post-build AST envelope', async () => {
      const { bundle, service } = buildConflictBundle(3);
      const matchingArgs = { uri: URI_A, clientId: 'editor-1', model: 'name:matched\n', baseVersion: 3 };
      const doc = await service.update(matchingArgs);
      // Text-document store records the bumped version (3 → 4) — the stub
      // `AstDocumentManager.update` increments by one. The returned AST
      // envelope's `version` mirrors the underlying `LangiumDocument.textDocument.version`;
      // the stub fixture's Langium doc is not advanced by text-document changes,
      // so we assert on the wire-side counter via `TextDocuments.version`.
      expect(bundle.textDocuments.changes.find(change => change.text === 'name:matched\n')).toBeDefined();
      expect(bundle.textDocuments.version(URI_A)).toBe(4);
      expect(doc.uri).toBe(URI_A);
      expect(typeof doc.version).toBe('number');
   });

   it('save() gates on the same based-on version (delegates to update)', async () => {
      const { service } = buildConflictBundle(3);
      const staleSave = { uri: URI_A, clientId: 'editor-1', model: 'name:newer\n', baseVersion: 1 };
      await expect(service.save(staleSave)).rejects.toBeInstanceOf(ConflictError);
   });
});

describe('ModelService AST envelopes', () => {
   it('waitForDocumentState returns an AstDocument that carries the text-document version', async () => {
      const { bundle, service } = buildConflictBundle(7);
      // Stub LangiumDocuments resolves the URI through `getDocument`; the
      // seed at v7 surfaces as the envelope's `version` field.
      const doc = await service.waitForDocumentState(URI_A, DocumentState.Validated);
      expect(doc.version).toBe(7);
      void bundle; // bundle currently unused beyond seeding
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

   it('allows the same rebuild from outside a write-lock holder', async () => {
      // The control that makes the rejection above meaningful: without it, a
      // guard that rejected unconditionally would pass that test too.
      setWriteLockScope(nodeWriteLockScope);
      const bundle = makeTestServices<FakeRoot>();
      await expect(bundle.modelService.rebuild(URI_A)).resolves.toBeDefined();
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
   });

   it('allows a reentrant rebuild when build serialisation is off', async () => {
      // With `serializeBuilds: false` nothing acquires the lock, so there is
      // nothing to be reentrant about — which makes the existing opt-out the
      // guard's opt-out, and is why the check sits on that branch.
      setWriteLockScope(nodeWriteLockScope);
      const bundle = makeTestServices<FakeRoot>({ modelServiceOptions: { serializeBuilds: false } });
      await bundle.services.workspace.WorkspaceLock.write(async () => {
         await bundle.modelService.rebuild(URI_A);
      });
      expect(bundle.documentBuilder.updateCalls).toHaveLength(1);
   });

   it('deadlocks without a tracker, which is the failure the detection replaces', async () => {
      // The measured justification for the whole mechanism, and for throwing
      // rather than warning: with no tracker installed the reentrant call is
      // NOT merely slower, it never completes. The inner `write` waits for the
      // outer holder to release while the outer waits for the inner call, so
      // both hang. A host without async-context support (a browser bundle)
      // keeps exactly this behaviour — the degradation is a missing diagnosis,
      // not a new failure.
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
 * "ready at vN (superseded)" when a concurrent write advanced the version
 * past `appliedVersion` before this update settled. Pure observability —
 * resolution is read-latest, so the promise still resolves either way.
 *
 * The lines are `debug`-level; `AbstractLogger.send` drops anything above
 * the process-global threshold (default `info`), so each test raises the
 * threshold to `debug` and restores it in `finally`.
 */
describe('ModelService update supersession', () => {
   function buildSupersessionService(): {
      service: ModelService<FakeRoot>;
      lines: CapturedLine[];
      bundle: ReturnType<typeof makeTestServices<FakeRoot>>;
   } {
      const { logger, lines } = makeCapturingLogger();
      const bundle = makeTestServices<FakeRoot>({
         logger,
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), options: { version: 1 } }]
      });
      const service = new DefaultModelService<FakeRoot>(bundle.services);
      // Current text-doc version = 1, matching `args.baseVersion: 1` so the
      // conflict gate stays inert; `AstDocumentManager.update` then bumps
      // to v2, making `appliedVersion = 2`.
      bundle.textDocuments.seedOpen(URI_A, 'v1', 'editor-1');
      return { service, lines, bundle };
   }

   const supersessionLines = (lines: CapturedLine[]): CapturedLine[] => lines.filter(line => /Update to v\d+ ready/.test(line.message));

   it('logs "ready" without the superseded suffix when no newer version overtakes', async () => {
      const { service, lines } = buildSupersessionService();
      const previous = Logger.getLevel();
      Logger.setLevel('debug');
      try {
         await service.update({ uri: URI_A, clientId: 'editor-1', model: 'a', baseVersion: 1 });
         const ready = supersessionLines(lines);
         expect(ready).toHaveLength(1);
         expect(ready[0].message).toMatch(/Update to v\d+ ready$/);
         expect(ready[0].message).not.toContain('superseded');
      } finally {
         Logger.setLevel(previous);
      }
   });

   it('logs "ready at vN (superseded)" yet still resolves when a newer version overtakes before settling', async () => {
      const { service, lines, bundle } = buildSupersessionService();
      const previous = Logger.getLevel();
      Logger.setLevel('debug');
      try {
         // Hold the NEXT waitUntil — update #1's rebuild — so a concurrent
         // writer can overtake the version before update #1 settles.
         const gate = bundle.documentBuilder.gateNextWaitUntil();
         const inFlight = service.update({ uri: URI_A, clientId: 'editor-1', model: 'a', baseVersion: 1 });
         // Spin the microtask queue until update #1 has driven its await chain
         // (open → apply text → rebuild's DocumentBuilder.update → Logger.time)
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
         expect(ready[0].message).toMatch(/Update to v2 ready at v3 \(superseded\)/);
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
      bundle.textDocuments.seedOpen(URI_A, 'name: a\n', 'editor-1');
      // Pass `model` as a string to bypass the rewrite + serialize path; no
      // `version` so the conflict gate is inert (covered elsewhere).
      await bundle.modelService.save({ uri: URI_A, clientId: 'editor-1', model: 'name: saved\n' });
      // update applied the new text...
      const change = bundle.textDocuments.changes.find(entry => entry.text === 'name: saved\n');
      expect(change).toBeDefined();
      // ...then save persisted through the file system and recorded the save.
      expect(bundle.fileSystem.writes.map(write => write.uri)).toContain(URI_A);
      expect(bundle.textDocuments.saves).toContainEqual({ uri: URI_A, clientId: 'editor-1' });
   });
});

/**
 * The LSP-client sync. One
 * persistent `onDocumentPhase(IntegrityService.SettledState)` listener mirrors
 * server-side changes back to the language client via two distinct mechanisms:
 *  - **LSP sync** (open in the language client) → coalesced `applyEditToLanguageClient`,
 *    routed by **content**: the shadow no-ops the RPC when Monaco already matches,
 *    so a Monaco echo and a cascade-unchanged doc both cost nothing. Author is
 *    irrelevant on this path.
 *  - **pending staging** (closed in the language client) → `stagePendingContent`
 *    for the eventual first `didOpen`, gated by **provenance**: stage only a
 *    genuine client edit (`hasKnownAuthor && isTriggeringEdit`). An internal build
 *    (no author — `getAuthor` → `undefined` — from startup, a cascade relink, or
 *    a didClose-reload) is NOT staged: its text equals disk or is a transient
 *    teardown flush, and staging it would pre-stage every file on boot / resurrect
 *    discarded content on reopen.
 * Integrity corrections need no special casing: the corrected text lands in the
 * synced store in place, so an open corrected doc takes the LSP-sync path. The
 * listener re-derives from the settled state every time, so it is self-healing.
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

   /**
    * Bundle whose stub `AstDocumentManager` reports fixed open / direct-change /
    * author verdicts — the inputs the drain reads. When `author` is omitted it
    * defaults to a real client id so the staging tests exercise the "genuine
    * client edit" path; pass `author: undefined` explicitly to exercise the
    * internal-build gate (no client authored the version — `getAuthor` reports
    * `undefined`). (The open path never reads the author — it returns before the
    * `getAuthor` call.)
    */
   function buildSyncBundle(verdict: { open: boolean; direct: boolean; author?: string }): ReturnType<typeof makeTestServices<FakeRoot>> {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const documents = bundle.astDocumentManager as unknown as {
         isTriggeringEdit: () => boolean;
         getAuthor: () => string | undefined;
      };
      // `syncToLanguageClient` routes on the text store's open-state predicate:
      // open in the language client → `applyEditToLanguageClient`; not open →
      // staging path. (The egress translates the canonical key to the recorded
      // client URI; presence is all the routing needs.)
      if (verdict.open) {
         bundle.textDocuments.seedOpenInLanguageClient(URI_A);
      }
      documents.isTriggeringEdit = () => verdict.direct;
      documents.getAuthor = () => ('author' in verdict ? verdict.author : 'form-client');
      return bundle;
   }

   it('applyEdits an open doc when it settles (LSP-sync path ignores authorship)', async () => {
      const bundle = buildSyncBundle({ open: true, direct: true });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => ({ uri: edit.uri, text: edit.text }))).toEqual([{ uri: URI_A, text: 'name:b' }]);
      expect(bundle.textDocuments.staged).toEqual([]);
   });

   it('applyEdits an open doc even when only cascade-affected (integrity corrections ride this path)', async () => {
      // No direct change: an open corrected doc still syncs, because the corrected
      // text is in the store and the shadow decides delivery.
      const bundle = buildSyncBundle({ open: true, direct: false });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:corrected'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => edit.text)).toEqual(['name:corrected']);
   });

   it('stages (no applyEdit) a client-authored direct change not yet open in the language client', async () => {
      const bundle = buildSyncBundle({ open: false, direct: true, author: 'form-client' });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits).toEqual([]);
      expect(bundle.textDocuments.staged).toEqual([{ uri: URI_A, text: 'name:b' }]);
   });

   it('does NOT stage a closed internal-build change (no author) — disk stays authoritative', async () => {
      // The provenance gate: a directly-changed-but-not-client-authored build
      // (startup, cascade relink, didClose-reload reports no author) must not
      // stage, or it would pre-stage every file on boot and resurrect discarded
      // content on reopen.
      const bundle = buildSyncBundle({ open: false, direct: true, author: undefined });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits).toEqual([]);
      expect(bundle.textDocuments.staged).toEqual([]);
   });

   it('skips a closed cascade-affected doc whose text did not change (no stage, no applyEdit)', async () => {
      // Not directly changed and not open: nothing the client needs.
      const bundle = buildSyncBundle({ open: false, direct: false, author: 'form-client' });
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:a'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits).toEqual([]);
      expect(bundle.textDocuments.staged).toEqual([]);
   });

   it('re-syncs on every settle (self-healing) — not a one-shot enrolment', async () => {
      const bundle = buildSyncBundle({ open: true, direct: true });
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
      const bundle = buildSyncBundle({ open: true, direct: true });
      let calls = 0;
      bundle.textDocuments.setApplyEditHandler(() => ({ applied: ++calls > 1 }));
      bundle.documentBuilder.firePhase(IntegrityService.SettledState, settledDoc(URI_A, 'name:b'));
      await drainSync();
      expect(bundle.textDocuments.appliedEdits.map(edit => edit.text)).toEqual(['name:b', 'name:b']);
   });

   it('bounds the re-push at one, so a client that refuses everything does not spin', async () => {
      const bundle = buildSyncBundle({ open: true, direct: true });
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
      const bundle = buildSyncBundle({ open: true, direct: true });
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
class RecordingModelService extends DefaultModelService<FakeRoot, TransferDiagnostic, FakeRoot> {
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
      service: RecordingModelService;
      order: string[];
   } {
      const order: string[] = [];
      const bundle = makeTestServices<FakeRoot, TransferDiagnostic, FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
         modelService: services => new RecordingModelService(services, order)
      });
      bundle.textDocuments.seedOpen(URI_A, 'name: a\n', 'editor-1');
      return { service: bundle.modelService as RecordingModelService, order };
   }

   it('serialises a structured (object) payload', async () => {
      const { service, order } = buildRecordingService();
      // No `version` → conflict gate inert; the structured root drives the
      // `serialize(uri, rewriteModel(model))` branch of `modelToText`.
      await service.update({ uri: URI_A, clientId: 'editor-1', model: { $type: 'FakeRoot', name: 'x' } });
      expect(order).toEqual(['serialize']);
   });

   it('bypasses serialize for a pre-serialised string payload', async () => {
      const { service, order } = buildRecordingService();
      await service.update({ uri: URI_A, clientId: 'editor-1', model: 'name: x\n' });
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
 * Pins the slow-warn-gated stopwatch allocation in `update`
 * (`this.slowUpdateWarn !== undefined ? Clock.stopwatch() : undefined`).
 * When no threshold is configured the slow-warn path is dead, so the
 * stopwatch must NOT be allocated; when one is configured it must be.
 * Wraps the bound `Clock.stopwatch` to count allocations, so an
 * unconditional allocation shows up as a count rather than as no symptom.
 */
describe('ModelService update stopwatch allocation', () => {
   function buildCountingService(slowUpdateWarnMs?: number): {
      service: DelayedModelService<FakeRoot>;
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
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const service = new DelayedModelService<FakeRoot>(bundle.services, { slowUpdateWarnMs });
      return { service, stopwatchCalls: () => calls };
   }

   it('does not allocate a stopwatch when slowUpdateWarnMs is undefined', async () => {
      const { service, stopwatchCalls } = buildCountingService(undefined);
      await service.update(updateArgs);
      expect(stopwatchCalls()).toBe(0);
   });

   it('allocates a stopwatch when slowUpdateWarnMs is configured', async () => {
      const { service, stopwatchCalls } = buildCountingService(5);
      await service.update(updateArgs);
      expect(stopwatchCalls()).toBe(1);
   });
});

/**
 * Pins the `open({ uri, clientId, text })` call shape inside `update`.
 * `update` is an upsert: a cold URI is created from the serialised payload,
 * so the text and identifying fields must all be forwarded to `open`. The
 * capture asserts on the whole args object, so a dropped field is caught
 * rather than defaulting silently.
 */
describe('ModelService update open() arguments', () => {
   class OpenCapturingService extends DefaultModelService<FakeRoot> {
      readonly openArgs: OpenModelArgs[] = [];
      override async open(args: OpenModelArgs): Promise<Disposable> {
         this.openArgs.push(args);
         return HydraniumDisposable.EMPTY;
      }
      override async rebuild(): Promise<never> {
         return undefined as never;
      }
   }

   it('forwards uri, clientId, and serialised text to open', async () => {
      const bundle = makeTestServices<FakeRoot>({
         seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }]
      });
      const service = new OpenCapturingService(bundle.services);
      // The capturing `open` override swallows the real open, which is what
      // materialises the synced document — seed it so the downstream content
      // apply finds an open document.
      bundle.textDocuments.seedOpen(URI_A, '', 'test-client');
      await service.update({ uri: URI_A, clientId: 'test-client', model: 'name: payload\n' });
      expect(service.openArgs).toHaveLength(1);
      expect(service.openArgs[0]).toEqual({ uri: URI_A, clientId: 'test-client', text: 'name: payload\n' });
   });
});

/**
 * Pins the empty `{ uri, version: 0, root, diagnostics }` envelope
 * `toAstDocument` returns when the document is absent from the registry.
 * Every field is asserted — uri echoed, version 0, diagnostics empty — so an
 * envelope that degraded to all-undefined would not pass as merely empty.
 */
describe('ModelService toAstDocument absent-document envelope', () => {
   it('returns an empty envelope carrying the uri and version 0 when the document is absent', async () => {
      // No seedDocuments → LangiumDocuments.getDocument returns undefined →
      // the absent-document branch of `toAstDocument` builds the empty envelope.
      const bundle = makeTestServices<FakeRoot>();
      const doc = await bundle.modelService.waitForDocumentState(URI_A, DocumentState.Validated);
      expect(doc.uri).toBe(URI_A);
      expect(doc.version).toBe(0);
      expect(doc.root).toBeUndefined();
      expect(doc.diagnostics).toEqual([]);
   });
});
