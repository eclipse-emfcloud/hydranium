/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type CanonicalUri, Disposable, type LogThreshold, type Logger } from '@hydranium/protocol';
import {
   type BuildOptions,
   DocumentState,
   type DocumentPhaseListener,
   type FileSystemNode,
   type FileSystemProvider,
   type LangiumDocument
} from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { CancellationToken, type Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { type DocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import {
   DEFAULT_LOGGED_PHASES,
   type DocumentBuilderOptions,
   HydraniumDocumentBuilder
} from '../../../src/langium/document-builder/document-builder.js';
import { makeNoopLanguageServices, makeNoopLogger, makeNoopSharedServices, makeStubServiceRegistry } from '../../../src/testing/index.js';

/**
 * Test subclass exposing the framework's protected instrumentation surface as
 * public wrappers/getters so call sites read naturally without
 * casts. `onBuildPhase` stays abstract here — the factory subclasses it once
 * more with a closure-captured recording array (a class field can't be used:
 * subclass field initialisers run *after* super() returns, by which time
 * super() has already invoked `registerPhaseListeners()`).
 */
abstract class CapturingBuilder extends HydraniumDocumentBuilder {
   constructor(logger: Logger, options: DocumentBuilderOptions = {}) {
      super(makeStubServices(logger), options);
   }

   abstract override onBuildPhase(state: DocumentState): { dispose: () => void };

   callPhaseReachedLine(state: DocumentState, docs: LangiumDocument[], elapsedMs: number): string {
      return this.phaseReachedLine(state, docs, elapsedMs);
   }
   callSlowBuildPhaseLine(state: DocumentState, listenerCount: number, docs: LangiumDocument[], totalMs: number): string {
      return this.slowBuildPhaseLine(state, listenerCount, docs, totalMs);
   }
   callFormatUri(uri: URI): string {
      return this.formatUri(uri);
   }
   callDescribeListener(listener: { name?: string; displayName?: string }, index: number): string {
      return this.formatListener(listener as DocumentPhaseListener, index);
   }
   callPrepareBuild(documents: LangiumDocument[], options: BuildOptions): void {
      this.prepareBuild(documents, options);
   }
   callShouldValidate(document: LangiumDocument): boolean {
      return this.shouldValidate(document);
   }
   /** The build options currently retained for a document — what a resumed build continues under. */
   retainedBuildOptions(document: LangiumDocument): BuildOptions {
      return this.getBuildOptions(document);
   }
   /** Mark a document's build state incomplete, as a cancelled build leaves it. */
   markBuildIncomplete(document: LangiumDocument): void {
      const state = this.buildState.get(document.uri.toString());
      if (state) {
         state.completed = false;
      }
   }

   // Protected configuration fields, surfaced for the option-resolution tests.
   get resolvedLogLevel(): LogThreshold {
      return this.logLevel;
   }
   get resolvedLoggedPhases(): DocumentState[] {
      return this.loggedPhases;
   }
   get resolvedSlowPhaseMs(): number {
      return this.slowPhaseMs.value;
   }
   get resolvedSlowListenerMs(): number {
      return this.slowListenerMs.value;
   }
   get resolvedSlowBuildMs(): number {
      return this.slowBuildMs.value;
   }
}

function makeTestBuilder(
   logger: Logger,
   options: DocumentBuilderOptions = {}
): { builder: CapturingBuilder; registeredPhases: DocumentState[] } {
   const registeredPhases: DocumentState[] = [];
   class RecordingBuilder extends CapturingBuilder {
      override onBuildPhase(state: DocumentState): { dispose: () => void } {
         registeredPhases.push(state);
         return Disposable.EMPTY;
      }
   }
   const builder = new RecordingBuilder(logger, options);
   return { builder, registeredPhases };
}

/**
 * Minimal stub services tree — bypasses the full Langium DI graph. Tests verify
 * the framework's added behaviour (option resolution, listener registration,
 * format methods, virtual hooks) without instantiating a real
 * `DocumentBuilder` constructor that wants `LangiumDocuments`, `IndexManager`,
 * `TextDocuments`, etc.
 */
function makeStubServices(logger: Logger): ServerSharedServicesMinimal {
   // The builder defaults Tracer (a DefaultTracer over `logger`) and an empty
   // ServiceRegistry; only the LangiumDocuments stub is test-specific. Every
   // other slot resolves to undefined, which the builder tests never read.
   return makeNoopSharedServices({
      Logger: logger,
      workspace: {
         LangiumDocuments: { getDocument: () => undefined, all: { filter: () => ({ map: () => ({ toArray: () => [] }) }) } }
      }
   });
}

describe('HydraniumDocumentBuilder', () => {
   /**
    * The workspace-startup validation drop, at the layer that decides it.
    *
    * Langium's initial workspace build runs with `initialBuildOptions` (`{}` —
    * validation off) and `prepareBuild` RETAINS a previous build's options for
    * any document whose build did not complete. A write arriving during startup
    * cancels that build (`WorkspaceLock.write` cancels the in-flight write), so
    * the documents it had not finished keep `validation: false`; the write's own
    * build then inherits it, `shouldValidate` says no, and `buildDocuments`
    * marks them completed having never validated them. Measured end-to-end as
    * cross-grammar dependents that silently never publish diagnostics.
    *
    * This asserts the decision itself rather than the cascade, because
    * `shouldValidate` is the single point where the drop becomes irreversible.
    */
   describe('retained build options from a cancelled build', () => {
      function documentAt(uri: string): LangiumDocument {
         return { uri: URI.parse(uri), state: DocumentState.IndexedReferences } as unknown as LangiumDocument;
      }

      it('validates a document whose incomplete state was left by a non-validating build', () => {
         const { builder } = makeTestBuilder(makeNoopLogger(), { logLevel: 'off' });
         const document = documentAt('file:///a.x');

         // The initial workspace build: validation off, then cancelled partway.
         builder.callPrepareBuild([document], {});
         builder.markBuildIncomplete(document);
         expect(builder.callShouldValidate(document)).toBe(false);

         // The write's build asks for validation. The retained state must not
         // veto it — otherwise this document is completed, never validated.
         builder.callPrepareBuild([document], { validation: true });
         expect(builder.callShouldValidate(document)).toBe(true);
      });

      it('leaves a retained state that already validates exactly as it is', () => {
         const { builder } = makeTestBuilder(makeNoopLogger(), { logLevel: 'off' });
         const document = documentAt('file:///x.other');

         // A cancelled build that WAS validating, narrowed to one category. The
         // categories are the part worth protecting: they record which checks
         // already ran, so overwriting them re-runs work the cancelled build
         // had finished.
         builder.callPrepareBuild([document], { validation: { categories: ['built-in'] } });
         builder.markBuildIncomplete(document);
         // The next build asks for plain `validation: true`. The upgrade is for
         // a retained state that does NOT validate; firing it here would
         // replace the narrowed options with a bare `true`.
         builder.callPrepareBuild([document], { validation: true });

         expect(builder.callShouldValidate(document)).toBe(true);
         expect(builder.retainedBuildOptions(document).validation).toEqual({ categories: ['built-in'] });
      });
   });

   describe('option resolution', () => {
      it('uses framework defaults when no options supplied', () => {
         const { builder } = makeTestBuilder(makeNoopLogger());
         expect(builder.resolvedLogLevel).toBe('debug');
         expect(builder.resolvedLoggedPhases).toEqual(DEFAULT_LOGGED_PHASES);
         expect(builder.resolvedSlowPhaseMs).toBe(25);
         expect(builder.resolvedSlowListenerMs).toBe(5);
         expect(builder.resolvedSlowBuildMs).toBe(25);
      });

      it('overrides individual options, leaving the rest at defaults', () => {
         const { builder } = makeTestBuilder(makeNoopLogger(), { logLevel: 'info', slowPhaseMs: 100 });
         expect(builder.resolvedLogLevel).toBe('info');
         expect(builder.resolvedSlowPhaseMs).toBe(100);
         expect(builder.resolvedLoggedPhases).toEqual(DEFAULT_LOGGED_PHASES);
         expect(builder.resolvedSlowListenerMs).toBe(5);
         expect(builder.resolvedSlowBuildMs).toBe(25);
      });
   });

   describe('phase listener registration', () => {
      it('registers a listener per logged phase by default', () => {
         const { registeredPhases } = makeTestBuilder(makeNoopLogger());
         expect(registeredPhases).toEqual(DEFAULT_LOGGED_PHASES);
      });

      it("registers no listeners when logLevel === 'off'", () => {
         const { registeredPhases } = makeTestBuilder(makeNoopLogger(), { logLevel: 'off' });
         expect(registeredPhases).toEqual([]);
      });

      it('respects a custom loggedPhases list', () => {
         const { registeredPhases } = makeTestBuilder(makeNoopLogger(), { loggedPhases: [DocumentState.Validated] });
         expect(registeredPhases).toEqual([DocumentState.Validated]);
      });
   });

   describe('format methods', () => {
      it('phaseReachedLine includes phase, doc info, and elapsed ms', () => {
         const { builder } = makeTestBuilder(makeNoopLogger());
         const doc = { uri: URI.parse('memory://x') } as LangiumDocument;
         const line = builder.callPhaseReachedLine(DocumentState.Linked, [doc], 12);
         expect(line).toContain(`'Linked'`);
         expect(line).toContain('memory://x');
         expect(line).toContain('12ms');
      });

      it('phaseReachedLine collapses multi-document runs to count', () => {
         const { builder } = makeTestBuilder(makeNoopLogger());
         const docs = [{ uri: URI.parse('memory://a') }, { uri: URI.parse('memory://b') }] as LangiumDocument[];
         const line = builder.callPhaseReachedLine(DocumentState.Parsed, docs, 5);
         expect(line).toContain('2 docs');
         expect(line).not.toContain('memory://a');
      });

      it('slowBuildPhaseLine includes listener count, doc count, and total ms', () => {
         const { builder } = makeTestBuilder(makeNoopLogger());
         const docs = [{ uri: URI.parse('memory://x') }] as LangiumDocument[];
         const line = builder.callSlowBuildPhaseLine(DocumentState.IndexedReferences, 3, docs, 67);
         expect(line).toContain(`'IndexedReferences'`);
         expect(line).toContain('3 listeners');
         expect(line).toContain('1 docs');
         expect(line).toContain('67ms');
      });

      it('formatUri default uses uri.toString()', () => {
         const { builder } = makeTestBuilder(makeNoopLogger());
         expect(builder.callFormatUri(URI.parse('memory://foo/bar'))).toBe('memory://foo/bar');
      });

      it('formatListener prefers displayName, falls back to function.name, then index', () => {
         const { builder } = makeTestBuilder(makeNoopLogger());
         expect(builder.callDescribeListener({ displayName: 'Custom' }, 0)).toBe('Custom');
         expect(builder.callDescribeListener({ name: 'foo' }, 0)).toBe('foo');
         expect(builder.callDescribeListener({}, 7)).toBe('#7');
         expect(builder.callDescribeListener({ name: 'anonymous' }, 3)).toBe('#3');
      });

      it('formatBuildStatus canonicalizes the URI so a divergent spelling resolves the document', () => {
         // The document is keyed by its real path R; a caller (e.g. a GLSP state
         // holding the symlink _sourceUri S) asks for status by S. formatBuildStatus
         // must canonicalize so it reports the loaded document's state, not "not
         // loaded" — the same canonicalize-at-the-door contract every other
         // document-lookup door upholds.
         const REAL = 'file:///real/x.a';
         const LINK = 'file:///link/x.a';
         const toText = (uri: URI | string): string => (typeof uri === 'string' ? uri : uri.toString());
         const linkAware: DocumentUriPolicy = {
            canonicalUri: uri => (toText(uri) === LINK ? REAL : toText(uri)) as CanonicalUri,
            loadUri: uri => URI.parse(toText(uri) === LINK ? REAL : toText(uri))
         };
         const services = makeStubServices(makeNoopLogger());
         services.workspace.DocumentUriPolicy = linkAware;
         services.workspace.LangiumDocuments.getDocument = (uri: URI) =>
            uri.toString() === REAL ? ({ state: DocumentState.Validated } as LangiumDocument) : undefined;
         const builder = new HydraniumDocumentBuilder(services, { logLevel: 'off' });
         const status = builder.formatBuildStatus(URI.parse(LINK));
         expect(status).toContain('Validated');
         expect(status).not.toContain('not loaded');
      });
   });

   describe('ensureLanguageFileExtensions (registered-extension cache)', () => {
      // The walk filters on this list, so a stale entry means files of a
      // late-registered language never build on a watched-directory change.
      class CacheBuilder extends HydraniumDocumentBuilder {
         extensions(): string[] {
            this.ensureLanguageFileExtensions();
            return this.languageFileExtensions;
         }
      }

      function makeCacheBuilder(registry: unknown): CacheBuilder {
         const services = makeNoopSharedServices({
            Logger: makeNoopLogger(),
            ServiceRegistry: registry,
            workspace: { DocumentUriPolicy: { canonicalUri: (uri: URI) => uri.toString() as CanonicalUri, loadUri: (uri: URI) => uri } }
         });
         return new CacheBuilder(services, { logLevel: 'off' });
      }

      it('picks up a language registered after the first expansion', () => {
         const registry = makeStubServiceRegistry([{ languageId: 'alpha', fileExtensions: ['.a'] }]);
         const builder = makeCacheBuilder(registry);
         expect(builder.extensions()).toEqual(['.a']);

         registry.register(makeNoopLanguageServices({ LanguageMetaData: { languageId: 'beta', fileExtensions: ['.b'] } }));
         expect(builder.extensions().sort()).toEqual(['.a', '.b']);
      });

      it('picks up a language REPLACED after the first expansion', () => {
         // `register` keys on language id, so a replacement leaves `all.length`
         // alone — the cache has to key on the registry's registration counter
         // to notice. Keyed on the count, this returned the stale `['.a']`.
         const registry = makeStubServiceRegistry([{ languageId: 'alpha', fileExtensions: ['.a'] }]);
         const builder = makeCacheBuilder(registry);
         expect(builder.extensions()).toEqual(['.a']);

         registry.register(makeNoopLanguageServices({ LanguageMetaData: { languageId: 'alpha', fileExtensions: ['.a', '.a2'] } }));
         expect(builder.extensions().sort()).toEqual(['.a', '.a2']);
      });
   });

   describe('flattenAndAdaptURI (FileSystemProvider walk)', () => {
      // An in-memory tree: key = uri string, value = directory children (a leaf
      // is absent from the map). The fake provider mirrors NodeFileSystem's
      // shape — statSync throws for unknown paths, readDirectorySync returns
      // each child's own isDirectory flag (so the walk stats each node once).
      function makeFsProvider(dirs: Record<string, string[]>): FileSystemProvider {
         const node = (uri: URI): FileSystemNode => ({ uri, isDirectory: uri.toString() in dirs, isFile: !(uri.toString() in dirs) });
         return {
            statSync: (uri: URI) => {
               if (!(uri.toString() in dirs) && !Object.values(dirs).some(children => children.includes(uri.toString()))) {
                  throw new Error(`ENOENT: ${uri.toString()}`);
               }
               return node(uri);
            },
            readDirectorySync: (uri: URI) => (dirs[uri.toString()] ?? []).map(child => node(URI.parse(child)))
         } as unknown as FileSystemProvider;
      }

      // loadUri = identity (the DefaultDocumentUriPolicy contract); a dedicated
      // case overrides it to model "no on-disk content".
      const identityPolicy: DocumentUriPolicy = {
         canonicalUri: uri => (typeof uri === 'string' ? uri : uri.toString()) as CanonicalUri,
         loadUri: uri => URI.parse(typeof uri === 'string' ? uri : uri.toString())
      };

      // Test subclass exposing the walk. `flattenAndAdaptURI` and
      // `languageFileExtensions` are protected on the framework builder, so a
      // subclass reaches them directly — no cast. (`flattenAndAdaptURI` reads the
      // extensions but doesn't populate them — `update()` does — so seed them.)
      class WalkBuilder extends HydraniumDocumentBuilder {
         constructor(services: ServerSharedServicesMinimal) {
            super(services, { logLevel: 'off' });
            this.languageFileExtensions = ['.a'];
         }
         flatten(uri: string): string[] {
            return this.flattenAndAdaptURI(URI.parse(uri)).map(resolved => resolved.toString());
         }
      }

      function makeWalkBuilder(fsProvider: FileSystemProvider, uriPolicy: DocumentUriPolicy = identityPolicy): WalkBuilder {
         // FileSystemProvider goes in as an override (the walk stub is read-only, so
         // it doesn't satisfy the slot's writable narrowing — the loose override slot
         // accepts it without a per-slot cast).
         const services = makeNoopSharedServices({
            Logger: makeNoopLogger(),
            workspace: {
               LangiumDocuments: { getDocument: () => undefined, all: { filter: () => ({ map: () => ({ toArray: () => [] }) }) } },
               FileSystemProvider: fsProvider,
               DocumentUriPolicy: uriPolicy
            }
         });
         return new WalkBuilder(services);
      }

      it('expands a directory to its language files, recursing into subdirectories', () => {
         const provider = makeFsProvider({
            'file:///ws': ['file:///ws/a.a', 'file:///ws/sub', 'file:///ws/readme.txt'],
            'file:///ws/sub': ['file:///ws/sub/b.a']
         });
         expect(makeWalkBuilder(provider).flatten('file:///ws').sort()).toEqual(['file:///ws/a.a', 'file:///ws/sub/b.a']);
      });

      it('returns a single language file unchanged', () => {
         const provider = makeFsProvider({ 'file:///ws': ['file:///ws/a.a'] });
         expect(makeWalkBuilder(provider).flatten('file:///ws/a.a')).toEqual(['file:///ws/a.a']);
      });

      it('filters out a non-language file passed directly', () => {
         const provider = makeFsProvider({ 'file:///ws': ['file:///ws/readme.txt'] });
         expect(makeWalkBuilder(provider).flatten('file:///ws/readme.txt')).toEqual([]);
      });

      it('returns [] when the policy reports no loadable URI', () => {
         const provider = makeFsProvider({ 'file:///ws': ['file:///ws/a.a'] });
         const noContent: DocumentUriPolicy = {
            canonicalUri: uri => (typeof uri === 'string' ? uri : uri.toString()) as CanonicalUri,
            loadUri: () => undefined
         };
         expect(makeWalkBuilder(provider, noContent).flatten('file:///ws/a.a')).toEqual([]);
      });

      it('treats a missing path as a non-directory (no throw)', () => {
         const provider = makeFsProvider({});
         expect(makeWalkBuilder(provider).flatten('file:///ws/ghost.a')).toEqual(['file:///ws/ghost.a']);
      });
   });

   describe('resetToState — rehydrate-on-re-entry (CST residency)', () => {
      // Stub the dependencies that the inherited `resetToState` touches so it runs
      // without the full DI graph (index removal + linker unlink are no-ops here;
      // the test only asserts the resulting target state). `indexManager` and
      // `serviceRegistry` are DI-injected on the base builder
      // (`services.workspace.IndexManager` / `services.ServiceRegistry`), so the
      // doubles go in through the services tree — the seam an adopter uses — not
      // by reassigning fields after construction.
      function rehydrateBuilder(refreshCrossDocumentComputedScopes = false): HydraniumDocumentBuilder {
         const services = makeNoopSharedServices({
            Logger: makeNoopLogger(),
            ServiceRegistry: { getServices: () => ({ references: { Linker: { unlink: () => undefined } } }) },
            workspace: {
               LangiumDocuments: { getDocument: () => undefined, all: { filter: () => ({ map: () => ({ toArray: () => [] }) }) } },
               IndexManager: { removeContent: () => undefined, removeReferences: () => undefined, remove: () => undefined }
            }
         });
         return new HydraniumDocumentBuilder(services, { logLevel: 'off', refreshCrossDocumentComputedScopes });
      }
      function doc(state: DocumentState, root: object | undefined): LangiumDocument {
         return { uri: URI.parse('file:///a.a'), state, parseResult: { value: root } } as unknown as LangiumDocument;
      }

      it('relinking a shed document forces a full re-parse (reset to Changed)', () => {
         const builder = rehydrateBuilder();
         const shed = doc(DocumentState.Validated, { $type: 'Model' });
         builder.resetToState(shed, DocumentState.ComputedScopes);
         expect(shed.state).toBe(DocumentState.Changed);
      });

      it('resident document keeps ComputedScopes by default (no cross-doc refresh)', () => {
         const builder = rehydrateBuilder();
         const resident = doc(DocumentState.Validated, { $type: 'Model', $cstNode: {} });
         builder.resetToState(resident, DocumentState.ComputedScopes);
         expect(resident.state).toBe(DocumentState.ComputedScopes);
      });

      it('resident document drops to IndexedContent when refreshCrossDocumentComputedScopes is set', () => {
         const builder = rehydrateBuilder(true);
         const resident = doc(DocumentState.Validated, { $type: 'Model', $cstNode: {} });
         builder.resetToState(resident, DocumentState.ComputedScopes);
         expect(resident.state).toBe(DocumentState.IndexedContent);
      });
   });

   describe('subclass overrides', () => {
      it('formatUri override is honoured by phaseReachedLine', () => {
         const logger = makeNoopLogger();
         class SubclassBuilder extends HydraniumDocumentBuilder {
            protected override formatUri(uri: URI): string {
               return `[ws]${uri.path}`;
            }
            override onBuildPhase(): { dispose: () => void } {
               return Disposable.EMPTY;
            }
            callPhaseReachedLine(state: DocumentState, docs: LangiumDocument[], elapsedMs: number): string {
               return this.phaseReachedLine(state, docs, elapsedMs);
            }
         }
         const builder = new SubclassBuilder(makeStubServices(logger));
         const doc = { uri: URI.parse('file:///foo.a') } as LangiumDocument;
         const line = builder.callPhaseReachedLine(DocumentState.Linked, [doc], 1);
         expect(line).toContain('[ws]/foo.a');
      });
   });

   describe('awaitDocumentState — liveness of the replaced rejection', () => {
      // Langium rejects when the workspace has already passed the requested
      // state without carrying the document along; this class waits instead,
      // which makes keeping that wait resolvable its own responsibility. The
      // regression these guard: after a workspace init (Langium's default
      // `initialBuildOptions` leave `validation` unset) documents sit at
      // `IndexedReferences` while the builder's `currentState` still reaches
      // `Validated`, because the validation phase ran over an empty list. A
      // first read wanting diagnostics then waited on a phase notification that
      // no future build was going to emit.
      class OrphanBuilder extends HydraniumDocumentBuilder {
         readonly updateCalls: string[][] = [];
         constructor(document: LangiumDocument | undefined, workspaceState: DocumentState) {
            super(makeServicesWithDocument(document), { logLevel: 'off' });
            this.currentState = workspaceState;
         }
         override update(changed: URI[]): Promise<void> {
            this.updateCalls.push(changed.map(uri => uri.toString()));
            return Promise.resolve();
         }
         callAwaitDocumentState(state: DocumentState, uri: URI): Promise<URI> {
            return this.awaitDocumentState(state, uri, CancellationToken.None);
         }
         /** Stand in for the build that a re-queue would have produced. */
         firePhase(document: LangiumDocument, state: DocumentState): Promise<void> {
            return this.notifyDocumentPhase(document, state, CancellationToken.None);
         }
         /**
          * Stand in for a build finishing its `Validated` phase. The document
          * list must be non-empty: Langium skips the notification entirely when
          * no document reached the phase, so passing `[]` silently fires
          * nothing and any assertion about the listener passes vacuously.
          */
         fireBuildPhase(state: DocumentState): Promise<void> {
            return this.notifyBuildPhase([documentAt(state)], state, CancellationToken.None);
         }
      }

      function makeServicesWithDocument(document: LangiumDocument | undefined): ServerSharedServicesMinimal {
         return makeNoopSharedServices({
            Logger: makeNoopLogger(),
            workspace: {
               LangiumDocuments: { getDocument: () => document, all: { filter: () => ({ map: () => ({ toArray: () => [] }) }) } }
            }
         });
      }

      const DOC_URI = URI.parse('file:///workspace/a.a');
      const documentAt = (state: DocumentState): LangiumDocument => ({ uri: DOC_URI, state }) as LangiumDocument;

      it('re-queues a build when the workspace already passed the target state', async () => {
         const builder = new OrphanBuilder(documentAt(DocumentState.IndexedReferences), DocumentState.Validated);
         const pending = builder.callAwaitDocumentState(DocumentState.Validated, DOC_URI);

         // The build must be scheduled synchronously with arming the wait, not
         // deferred to a later phase event — there is no later phase event.
         expect(builder.updateCalls).toEqual([[DOC_URI.toString()]]);

         // And the wait is still armed, so the re-queued build's phase
         // notification resolves it rather than arriving before anyone listens.
         await builder.firePhase(documentAt(DocumentState.Validated), DocumentState.Validated);
         await expect(pending).resolves.toBeDefined();
      });

      it('does not re-queue while a build is still working toward the target state', async () => {
         // `build`/`update` reset `currentState` to `Changed` and step it per
         // phase, so a value below the target means a build is in flight and
         // will emit the notification — re-queuing would be a wasted rebuild.
         const builder = new OrphanBuilder(documentAt(DocumentState.Linked), DocumentState.ComputedScopes);
         const pending = builder.callAwaitDocumentState(DocumentState.Validated, DOC_URI);
         expect(builder.updateCalls).toEqual([]);

         builder.notifyDocumentPhase(documentAt(DocumentState.Validated), DocumentState.Validated, CancellationToken.None);
         await expect(pending).resolves.toBeDefined();
      });

      it('stops re-queuing once builds stop advancing the document', async () => {
         // The hazard the entry-time re-queue would otherwise open: each build's
         // own completion re-triggers the orphan branch, so a document the
         // builder never carries to the target — an adopter narrowing
         // `shouldValidate`, say — would spin builds forever. `update` here
         // stands in for exactly that: it "builds" without advancing the state.
         const stuck = documentAt(DocumentState.IndexedReferences);
         const builder = new OrphanBuilder(stuck, DocumentState.Validated);
         void builder.callAwaitDocumentState(DocumentState.Validated, DOC_URI);
         expect(builder.updateCalls).toHaveLength(1);

         for (let i = 0; i < 10; i++) {
            await builder.fireBuildPhase(DocumentState.Validated);
         }

         // Bounded, not one-shot: a re-queue legitimately fails to land while a
         // busy workspace keeps cancelling builds, so a few retries are allowed
         // before giving up.
         expect(builder.updateCalls.length).toBeLessThanOrEqual(5);
      });

      it('keeps re-queuing while each build advances the document', async () => {
         // The counter is reset by progress, so a document crawling forward
         // one phase per (repeatedly cancelled) build is not mistaken for a
         // stuck one and abandoned short of the target.
         const crawling = documentAt(DocumentState.Parsed);
         const builder = new OrphanBuilder(crawling, DocumentState.Validated);
         void builder.callAwaitDocumentState(DocumentState.Validated, DOC_URI);

         for (const state of [DocumentState.IndexedContent, DocumentState.ComputedScopes, DocumentState.Linked]) {
            crawling.state = state;
            await builder.fireBuildPhase(DocumentState.Validated);
         }

         // One per observation, none suppressed — 1 at registration + 3 more.
         expect(builder.updateCalls).toHaveLength(4);
      });

      it('resolves immediately without re-queuing when the document already reached the target', async () => {
         const builder = new OrphanBuilder(documentAt(DocumentState.Validated), DocumentState.Validated);
         await expect(builder.callAwaitDocumentState(DocumentState.Validated, DOC_URI)).resolves.toBeDefined();
         expect(builder.updateCalls).toEqual([]);
      });
   });

   describe('dedupeDiagnostics', () => {
      // The guard on `serializeBuilds: false`, where two unserialised validation
      // passes make Langium append a second full set onto the first. The contract
      // under test is that it removes ONLY byte-identical entries — anything else
      // would silently drop a distinct finding, and `data` in particular carries
      // quick-fix payloads.
      class ExposedBuilder extends HydraniumDocumentBuilder {
         callDedupe(document: LangiumDocument): void {
            this.dedupeDiagnostics(document);
         }
      }
      const builder = (): ExposedBuilder => new ExposedBuilder(makeStubServices(makeNoopLogger()), { logLevel: 'off' });
      const at = (line: number, extra: Partial<Diagnostic> = {}): Diagnostic =>
         ({
            range: { start: { line, character: 0 }, end: { line, character: 4 } },
            severity: DiagnosticSeverity.Error,
            message: 'boom',
            ...extra
         }) as Diagnostic;
      const withDiagnostics = (diagnostics: Diagnostic[]): LangiumDocument =>
         ({ uri: URI.parse('file:///a.a'), diagnostics }) as unknown as LangiumDocument;

      it('collapses an exactly duplicated set to one copy', () => {
         const document = withDiagnostics([at(1), at(2), at(1), at(2)]);
         builder().callDedupe(document);
         expect(document.diagnostics).toHaveLength(2);
      });

      it('keeps diagnostics that differ only in data, which carries quick fixes', () => {
         // The case a subset key would get wrong: same range, severity and
         // message, different code-action payload.
         const document = withDiagnostics([at(1, { data: { fix: 'a' } }), at(1, { data: { fix: 'b' } })]);
         builder().callDedupe(document);
         expect(document.diagnostics).toHaveLength(2);
      });

      it('keeps diagnostics that differ only in relatedInformation or code', () => {
         const document = withDiagnostics([
            at(3, { code: 'linking-error' }),
            at(3, { code: 'other-error' }),
            at(3, { relatedInformation: [] })
         ]);
         builder().callDedupe(document);
         expect(document.diagnostics).toHaveLength(3);
      });

      it('leaves a list with no duplicates untouched, array identity included', () => {
         const diagnostics = [at(1), at(2)];
         const document = withDiagnostics(diagnostics);
         builder().callDedupe(document);
         // Same array instance: no reassignment when nothing was removed, so a
         // caller holding a reference sees no churn.
         expect(document.diagnostics).toBe(diagnostics);
      });

      it('tolerates absent and single-entry diagnostics', () => {
         const empty = { uri: URI.parse('file:///a.a') } as unknown as LangiumDocument;
         expect(() => builder().callDedupe(empty)).not.toThrow();
         const single = withDiagnostics([at(1)]);
         builder().callDedupe(single);
         expect(single.diagnostics).toHaveLength(1);
      });
   });
});
