/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, NoopLogger, type Project, type Tracer } from '@hydranium/protocol';
import { type CapturedLine, makeCapturingLogger } from '../../../src/testing/make-test-tracer.js';
import { type DocumentBuilder, DocumentState, type LangiumDocument, type LangiumDocuments, URI } from '@hydranium/langium';
import { Disposable } from 'vscode-languageserver';
import type { WorkspaceFolder } from 'vscode-languageserver-types';
import type { ProjectChangeEvent } from '../../../src/langium/project/project-change-event.js';
import type { ProjectManager } from '../../../src/langium/project/project-manager.js';
import type { ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import type { AdditionalDocumentContribution } from '../../../src/langium/workspace/additional-document-contribution.js';
import { getLogFilePath, setLogFilePath } from '../../../src/langium/diagnostics/logger.js';
import { HydraniumWorkspaceManager } from '../../../src/langium/workspace/hydranium-workspace-manager.js';
import type * as WorkspaceManagerModule from '../../../src/langium/workspace/hydranium-workspace-manager.js';
import { DefaultDocumentUriPolicy, RealpathDocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import { makeCapturingTracer, makeNoopSharedServices, makeStubServiceRegistry } from '../../../src/testing/index.js';

const URI_A = URI.parse('file:///workspace/A.a');
const URI_B = URI.parse('file:///workspace/B.a');

class FakeProjectManager implements ProjectManager {
   readonly ready = Promise.resolve();
   discoverCalls: WorkspaceFolder[][] = [];
   protected readonly listeners: ((event: ProjectChangeEvent) => void)[] = [];

   async discoverProjects(folders: readonly WorkspaceFolder[]): Promise<void> {
      this.discoverCalls.push([...folders]);
   }

   onProjectsChanged(listener: (event: ProjectChangeEvent) => void): Disposable {
      this.listeners.push(listener);
      return Disposable.create(() => {
         const idx = this.listeners.indexOf(listener);
         if (idx >= 0) {
            this.listeners.splice(idx, 1);
         }
      });
   }

   fire(event: ProjectChangeEvent): void {
      for (const listener of this.listeners.slice()) {
         listener(event);
      }
   }

   isProjectDescriptor(): boolean {
      return false;
   }
   getProject(): Project | undefined {
      return undefined;
   }
   getProjectForNode(): Project | undefined {
      return undefined;
   }
   getProjectById(): Project | undefined {
      return undefined;
   }
   getProjects(): readonly Project[] {
      return [];
   }
   getProjectUris(): readonly URI[] {
      return [];
   }
   getVisibleProjects(): readonly string[] {
      return [];
   }
   isVisible(): boolean {
      return false;
   }
   isSingleProject(): boolean {
      return true;
   }
   isUnqualifiedProjectReference(): boolean {
      return true;
   }
}

interface ResetCall {
   document: LangiumDocument;
   state: DocumentState;
}

interface Stubs {
   services: ServerSharedServicesMinimal;
   resetCalls: ResetCall[];
   knownDocs: Map<string, LangiumDocument>;
}

function makeStubs(projectManager: ProjectManager): Stubs {
   const knownDocs = new Map<string, LangiumDocument>();
   const resetCalls: ResetCall[] = [];
   const langiumDocuments = {
      getDocument: (uri: URI) => knownDocs.get(uri.toString()),
      hasDocument: (uri: URI) => knownDocs.has(uri.toString()),
      get all() {
         return Array.from(knownDocs.values());
      }
   } as unknown as LangiumDocuments;
   const documentBuilder = {
      resetToState: (document: LangiumDocument, state: DocumentState) => {
         resetCalls.push({ document, state });
      }
   } as unknown as DocumentBuilder;
   const services = makeNoopSharedServices({
      // A real registry: `warnIfUnroutable` consults it for every seeded
      // additional document, so a `{}` stub would crash rather than route.
      ServiceRegistry: makeStubServiceRegistry([{ languageId: 'test', fileExtensions: ['.test'] }]),
      workspace: {
         LangiumDocuments: langiumDocuments,
         DocumentBuilder: documentBuilder,
         FileSystemProvider: { readDirectory: async () => [] } as unknown,
         WorkspaceLock: { write: <T>(fn: () => Promise<T>) => fn() } as unknown,
         LangiumDocumentFactory: { fromModel: () => undefined, fromString: () => undefined } as unknown,
         ProjectManager: projectManager
      }
   });
   return { services, resetCalls, knownDocs };
}

describe('HydraniumWorkspaceManager — phase-0 discovery', () => {
   /**
    * Exposes the REAL `performStartup`. A subclass that re-implemented it would
    * assert against its own body instead of the framework's: the ordering
    * contract lives in the override, so overriding it away is the one thing this
    * fixture must not do.
    */
   class ExposingWorkspaceManager extends HydraniumWorkspaceManager {
      runPerformStartup(folders: WorkspaceFolder[]): Promise<LangiumDocument[]> {
         return this.performStartup(folders);
      }
   }

   /** Records discovery against Langium's folder traversal, the first thing `super.performStartup` does. */
   class RecordingProjectManager extends FakeProjectManager {
      constructor(protected readonly order: string[]) {
         super();
      }

      override async discoverProjects(folders: readonly WorkspaceFolder[]): Promise<void> {
         this.order.push('discoverProjects');
         await super.discoverProjects(folders);
      }
   }

   function setup(): { mgr: ExposingWorkspaceManager; projectManager: RecordingProjectManager; order: string[] } {
      const order: string[] = [];
      const projectManager = new RecordingProjectManager(order);
      const stubs = makeStubs(projectManager);
      // Replaced BEFORE construction: both `DefaultWorkspaceManager` and the
      // framework subclass capture the provider in their constructors.
      (stubs.services as unknown as { workspace: { FileSystemProvider: unknown } }).workspace.FileSystemProvider = {
         readDirectory: async (): Promise<never[]> => {
            order.push('traverseFolder');
            return [];
         }
      };
      return { mgr: new ExposingWorkspaceManager(stubs.services), projectManager, order };
   }

   it('discovers projects before Langium traverses the workspace folders', async () => {
      const { mgr, order } = setup();

      await mgr.runPerformStartup([{ uri: 'file:///workspace', name: 'workspace' }]);

      expect(order).toEqual(['discoverProjects', 'traverseFolder']);
   });

   it('passes the workspace folders through to discoverProjects', async () => {
      const { mgr, projectManager } = setup();
      const folders: WorkspaceFolder[] = [
         { uri: 'file:///workspace/proj-a', name: 'proj-a' },
         { uri: 'file:///workspace/proj-b', name: 'proj-b' }
      ];

      await mgr.runPerformStartup(folders);

      expect(projectManager.discoverCalls).toEqual([folders]);
   });
});

describe('HydraniumWorkspaceManager — path-divergence probe', () => {
   const LINK = 'file:///link/ws';
   const REAL = 'file:///real/ws';
   // realpath: the symlinked root resolves elsewhere; everything else is unchanged.
   const realpath = (uri: URI): URI | undefined => (uri.toString() === LINK ? URI.parse(REAL) : uri);

   class ExposingWorkspaceManager extends HydraniumWorkspaceManager {
      runProbe(folders: WorkspaceFolder[]): void {
         this.probePathDivergence(folders);
      }
   }

   function setup(policy: unknown): { mgr: ExposingWorkspaceManager; warnings: string[] } {
      const warnings: string[] = [];
      const tracer = {
         for: () => tracer,
         trace: () => tracer,
         warn: (message: string) => warnings.push(message)
      };
      const stubs = makeStubs(new FakeProjectManager());
      const services = stubs.services as unknown as {
         workspace: { FileSystemProvider: unknown; DocumentUriPolicy: unknown };
         Tracer: unknown;
      };
      services.workspace.FileSystemProvider = { realpath };
      services.workspace.DocumentUriPolicy = policy;
      services.Tracer = tracer;
      return { mgr: new ExposingWorkspaceManager(stubs.services), warnings };
   }

   it('warns when a workspace root resolves through a symlink, noting the policy collapses it', () => {
      const { mgr, warnings } = setup(new RealpathDocumentUriPolicy({ workspace: { FileSystemProvider: { realpath } } } as never));
      mgr.runProbe([{ uri: LINK, name: 'ws' }]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(REAL);
      expect(warnings[0]).toContain('collapses');
   });

   it('warns that a normalize-only policy does NOT collapse the divergent spellings', () => {
      const { mgr, warnings } = setup(new DefaultDocumentUriPolicy());
      mgr.runProbe([{ uri: LINK, name: 'ws' }]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('does NOT collapse');
   });

   it('emits nothing for a plain on-disk workspace root (no divergence)', () => {
      const { mgr, warnings } = setup(new RealpathDocumentUriPolicy({ workspace: { FileSystemProvider: { realpath } } } as never));
      mgr.runProbe([{ uri: REAL, name: 'ws' }]);
      expect(warnings).toEqual([]);
   });
});

describe('HydraniumWorkspaceManager — workspace log target', () => {
   class ExposingWorkspaceManager extends HydraniumWorkspaceManager {
      callResolveWorkspaceLogTarget(folders: WorkspaceFolder[]): void {
         this.resolveWorkspaceLogTarget(folders);
      }
   }

   afterEach(() => setLogFilePath(undefined));

   it('resolves the {workspace} log placeholder from the first folder', () => {
      setLogFilePath('/tmp/logs/{workspace}.log');
      const mgr = new ExposingWorkspaceManager(makeStubs(new FakeProjectManager()).services);

      mgr.callResolveWorkspaceLogTarget([{ uri: 'file:///tmp/cloud-ws-abc', name: 'cloud-ws-abc' }]);

      expect(getLogFilePath()).toBe('/tmp/logs/cloud-ws-abc.log');
   });

   it('does nothing when there are no folders', () => {
      setLogFilePath('/tmp/logs/{workspace}.log');
      const mgr = new ExposingWorkspaceManager(makeStubs(new FakeProjectManager()).services);

      mgr.callResolveWorkspaceLogTarget([]);

      // Target still pending — no folder to resolve the placeholder from.
      expect(getLogFilePath()).toBeUndefined();
   });
});

/**
 * The language the server renders in reaches the server LOG, in both outcomes.
 *
 * **The level is the property under test, not the wording.** The framework
 * ships no catalogue, so an undeclared locale and a code with no entry both
 * render the English and are indistinguishable in the output — which makes the
 * log the only thing that separates them, and makes a line below the default
 * threshold worth nothing. Both tests therefore run at `'info'` (the framework
 * default when no `HYDRANIUM_LOG_LEVEL` is set) and assert the captured level,
 * so a line demoted back to `'debug'` fails here rather than silently
 * disappearing from the log someone would be reading.
 *
 * Two tests because the two outcomes are emitted by two different objects —
 * `ServerLocale.accept` and this manager — for the reason `initialize`'s doc
 * gives. One of them passing says nothing about the other.
 */
describe('HydraniumWorkspaceManager — the declared locale in the log', () => {
   function initializeWith(locale: string | undefined): CapturedLine[] {
      const { tracer, lines } = makeCapturingTracer();
      const stubs = makeStubs(new FakeProjectManager());
      // Before the manager is constructed, so the lazily-built `ServerLocale`
      // takes this tracer too — it is the object that reports the declared case.
      (stubs.services as unknown as { Tracer: Tracer }).Tracer = tracer;
      const mgr = new HydraniumWorkspaceManager(stubs.services);

      mgr.initialize({ workspaceFolders: [], locale } as unknown as Parameters<HydraniumWorkspaceManager['initialize']>[0]);

      return lines;
   }

   function atInfo(run: () => CapturedLine[]): CapturedLine[] {
      const previousLevel = Logger.getLevel();
      Logger.setLevel('info');
      try {
         return run();
      } finally {
         Logger.setLevel(previousLevel);
      }
   }

   it('names the locale an init declared', () => {
      const locale = atInfo(() => initializeWith('xx-AA')).filter(line => line.message.includes('xx-AA'));

      expect(locale).toHaveLength(1);
      expect(locale[0].level).toBe('info');
   });

   it('says so when an init declared none, rather than leaving the log silent', () => {
      const lines = atInfo(() => initializeWith(undefined));

      const locale = lines.filter(line => line.message.includes('no locale declared'));
      expect(locale).toHaveLength(1);
      expect(locale[0].level).toBe('info');
      // And nothing claims a language — the failure a `''` fallback would make.
      expect(lines.filter(line => line.message.includes("locale '"))).toEqual([]);
   });
});

describe('HydraniumWorkspaceManager — cascade rebuild', () => {
   it('resets affected loaded documents to DocumentState.Changed on project change', () => {
      const projectManager = new FakeProjectManager();
      const stubs = makeStubs(projectManager);
      const docA = { uri: URI_A } as LangiumDocument;
      const docB = { uri: URI_B } as LangiumDocument;
      stubs.knownDocs.set(URI_A.toString(), docA);
      stubs.knownDocs.set(URI_B.toString(), docB);
      new HydraniumWorkspaceManager(stubs.services);

      projectManager.fire({
         added: [],
         updated: ['proj-A'],
         removed: [],
         affectedDocuments: [URI_A, URI_B]
      });

      expect(stubs.resetCalls).toHaveLength(2);
      expect(stubs.resetCalls[0]).toEqual({ document: docA, state: DocumentState.Changed });
      expect(stubs.resetCalls[1]).toEqual({ document: docB, state: DocumentState.Changed });
   });

   it('silently skips affected URIs whose documents are not loaded', () => {
      const projectManager = new FakeProjectManager();
      const stubs = makeStubs(projectManager);
      new HydraniumWorkspaceManager(stubs.services);

      projectManager.fire({
         added: [],
         updated: ['proj-A'],
         removed: [],
         affectedDocuments: [URI_A]
      });

      expect(stubs.resetCalls).toEqual([]);
   });

   it('no-op on event with empty affectedDocuments', () => {
      const projectManager = new FakeProjectManager();
      const stubs = makeStubs(projectManager);
      new HydraniumWorkspaceManager(stubs.services);
      projectManager.fire({ added: ['x'], updated: [], removed: [], affectedDocuments: [] });
      expect(stubs.resetCalls).toEqual([]);
   });
});

// ============================================================
// Additional documents
// ============================================================

describe('HydraniumWorkspaceManager — additional documents', () => {
   class ExposingWorkspaceManager extends HydraniumWorkspaceManager {
      runLoadAdditionalDocuments(folders: WorkspaceFolder[], collector: (document: LangiumDocument) => void): Promise<void> {
         return this.loadAdditionalDocuments(folders, collector);
      }
   }

   it('warns when a seeded document matches no registered language, naming the registered extensions', async () => {
      // An extensionless virtual URI is indexed but inert: every per-language
      // service resolves per URI, and a virtual document is never open in
      // TextDocuments, so the declared-languageId rung cannot serve it either.
      // Nothing else reports this — the document exists, it just does nothing.
      const stubs = makeStubs(new FakeProjectManager());
      const tracer = makeCapturingTracer();
      (stubs.services as unknown as { Tracer: unknown }).Tracer = tracer.tracer;
      (stubs.services as unknown as { additionalDocuments: Record<string, AdditionalDocumentContribution> }).additionalDocuments = {
         a: { registerAdditionalDocuments: registry => registry.register({ uri: URI.parse('virtual:lib') } as LangiumDocument) }
      };

      await new ExposingWorkspaceManager(stubs.services).runLoadAdditionalDocuments([], () => undefined);

      expect(tracer.lines.map(line => line.message).join('\n')).toMatch(/virtual:lib.*no registered language.*\.test/s);
   });

   it('stays quiet for a seeded document whose URI does route', async () => {
      const stubs = makeStubs(new FakeProjectManager());
      const tracer = makeCapturingTracer();
      (stubs.services as unknown as { Tracer: unknown }).Tracer = tracer.tracer;
      (stubs.services as unknown as { additionalDocuments: Record<string, AdditionalDocumentContribution> }).additionalDocuments = {
         a: {
            registerAdditionalDocuments: registry => registry.register({ uri: URI.parse('virtual:lib/lib.test') } as LangiumDocument)
         }
      };

      await new ExposingWorkspaceManager(stubs.services).runLoadAdditionalDocuments([], () => undefined);

      expect(tracer.lines.filter(line => line.message.includes('no registered language'))).toEqual([]);
   });

   it('collects documents registered by the additionalDocuments contribution group', async () => {
      const stubs = makeStubs(new FakeProjectManager());
      const docA = { uri: URI.parse('virtual:lib-a') } as LangiumDocument;
      const docB = { uri: URI.parse('virtual:lib-b') } as LangiumDocument;
      (stubs.services as unknown as { additionalDocuments: Record<string, AdditionalDocumentContribution> }).additionalDocuments = {
         a: { registerAdditionalDocuments: registry => registry.register(docA) },
         b: { registerAdditionalDocuments: registry => registry.register(docB) }
      };
      const mgr = new ExposingWorkspaceManager(stubs.services);

      const collected: LangiumDocument[] = [];
      await mgr.runLoadAdditionalDocuments([], document => collected.push(document));

      expect(collected).toEqual([docA, docB]);
   });

   it('hands the workspace folders passed to loadAdditionalDocuments to each contribution', async () => {
      const stubs = makeStubs(new FakeProjectManager());
      let seenFolders: readonly WorkspaceFolder[] | undefined;
      (stubs.services as unknown as { additionalDocuments: Record<string, AdditionalDocumentContribution> }).additionalDocuments = {
         a: { registerAdditionalDocuments: registry => void (seenFolders = registry.folders) }
      };
      const mgr = new ExposingWorkspaceManager(stubs.services);
      const folders: WorkspaceFolder[] = [{ uri: 'file:///ws', name: 'ws' }];

      await mgr.runLoadAdditionalDocuments(folders, () => undefined);

      expect(seenFolders).toEqual(folders);
   });

   it('is a no-op when the contribution group is empty', async () => {
      const stubs = makeStubs(new FakeProjectManager());
      const mgr = new ExposingWorkspaceManager(stubs.services);

      const collected: LangiumDocument[] = [];
      await mgr.runLoadAdditionalDocuments([], document => collected.push(document));

      expect(collected).toEqual([]);
   });

   it('logs a span with the contribution and document counts', async () => {
      const previousLevel = Logger.getLevel();
      Logger.setLevel('info');
      try {
         const { tracer, lines } = makeCapturingTracer();
         const stubs = makeStubs(new FakeProjectManager());
         (stubs.services as unknown as { Tracer: Tracer }).Tracer = tracer;
         (stubs.services as unknown as { additionalDocuments: Record<string, AdditionalDocumentContribution> }).additionalDocuments = {
            a: { registerAdditionalDocuments: r => r.register({ uri: URI.parse('virtual:a') } as LangiumDocument) },
            b: {
               registerAdditionalDocuments: r => {
                  r.register({ uri: URI.parse('virtual:b') } as LangiumDocument);
                  r.register({ uri: URI.parse('virtual:c') } as LangiumDocument);
               }
            }
         };
         const mgr = new ExposingWorkspaceManager(stubs.services);

         await mgr.runLoadAdditionalDocuments([], () => undefined);

         const line = lines.find(l => l.message.includes('Load additional documents') && l.message.includes('done'));
         expect(line).toBeDefined();
         expect(line!.message).toContain('2 contributions');
         expect(line!.message).toContain('3 documents');
      } finally {
         Logger.setLevel(previousLevel);
      }
   });

   it('emits no span when the contribution group is empty', async () => {
      const previousLevel = Logger.getLevel();
      Logger.setLevel('info');
      try {
         const { tracer, lines } = makeCapturingTracer();
         const stubs = makeStubs(new FakeProjectManager());
         (stubs.services as unknown as { Tracer: Tracer }).Tracer = tracer;
         const mgr = new ExposingWorkspaceManager(stubs.services);

         await mgr.runLoadAdditionalDocuments([], () => undefined);

         expect(lines.some(l => l.message.includes('Load additional documents'))).toBe(false);
      } finally {
         Logger.setLevel(previousLevel);
      }
   });
});

describe('HydraniumWorkspaceManager — wsRelativePath', () => {
   it('returns the path relative to the provided workspace', () => {
      const stubs = makeStubs(new FakeProjectManager());
      const mgr = new HydraniumWorkspaceManager(stubs.services);
      expect(mgr.wsRelativePath('file:///workspace/sub/A.a', 'file:///workspace')).toBe('sub/A.a');
   });

   it('falls back to the raw string when no workspace folder is known and the uri is a string', () => {
      const stubs = makeStubs(new FakeProjectManager());
      const mgr = new HydraniumWorkspaceManager(stubs.services);
      // No workspaceFolders configured -> default workspace is undefined ->
      // `typeof uri === 'string' ? uri : ...` returns the string unchanged.
      expect(mgr.wsRelativePath('file:///workspace/A.a')).toBe('file:///workspace/A.a');
   });

   it('falls back to uri.path.toString() when no workspace folder is known and the uri is a URI', () => {
      const stubs = makeStubs(new FakeProjectManager());
      const mgr = new HydraniumWorkspaceManager(stubs.services);
      // `typeof uri === 'string'` is false here -> `uri.path.toString()` branch.
      expect(mgr.wsRelativePath(URI.parse('file:///workspace/A.a'))).toBe('/workspace/A.a');
   });
});

// ============================================================
// OperationCancelled suppression
// ============================================================

describe('installOperationCancelledSuppression', () => {
   /**
    * The install latch is MODULE-level, and by the time any test in this worker
    * runs it is already `true` — so a delta measured against the live module
    * reads 0 whether or not the install happens, and cannot witness the
    * positive half of either contract. `vi.resetModules()` + a dynamic import
    * gives a module instance whose latch is still false; without it the
    * assertions below are satisfied by a constructor that installs nothing.
    *
    * The listener lands on the `process` singleton and outlives the test, so
    * each case removes whatever it added.
    */
   async function withFreshModule(body: (fresh: typeof WorkspaceManagerModule) => void): Promise<void> {
      vi.resetModules();
      const fresh = await import('../../../src/langium/workspace/hydranium-workspace-manager.js');
      const preexisting = new Set(process.listeners('unhandledRejection'));
      try {
         body(fresh);
      } finally {
         for (const listener of process.listeners('unhandledRejection')) {
            if (!preexisting.has(listener)) {
               process.removeListener('unhandledRejection', listener);
            }
         }
      }
   }

   it('installs exactly one process listener, however many times it is called', async () => {
      await withFreshModule(fresh => {
         const before = process.listenerCount('unhandledRejection');
         fresh.installOperationCancelledSuppression(new NoopLogger());
         expect(process.listenerCount('unhandledRejection') - before).toBe(1);
         fresh.installOperationCancelledSuppression(new NoopLogger());
         fresh.installOperationCancelledSuppression(new NoopLogger());
         expect(process.listenerCount('unhandledRejection') - before).toBe(1);
      });
   });

   it('routes a rejection through the most recent logger, not the first', async () => {
      await withFreshModule(fresh => {
         const first = makeCapturingLogger();
         const second = makeCapturingLogger();
         fresh.installOperationCancelledSuppression(first.logger);
         fresh.installOperationCancelledSuppression(second.logger);
         // Fire the listener directly: emitting a real unhandled rejection
         // would race the runner's own handler and leak across tests.
         const listener = process.listeners('unhandledRejection').at(-1) as (reason: unknown, promise: unknown) => void;
         listener(new Error('boom'), Promise.resolve());
         expect(second.lines.some(line => line.message.includes('boom'))).toBe(true);
         // The first tree's logger may be disposed by the time a later tree is
         // running, so reaching it is the defect, not a harmless duplicate.
         expect(first.lines.some(line => line.message.includes('boom'))).toBe(false);
      });
   });

   it('is invoked as a side effect of constructing HydraniumWorkspaceManager', async () => {
      await withFreshModule(fresh => {
         const before = process.listenerCount('unhandledRejection');
         new fresh.HydraniumWorkspaceManager(makeStubs(new FakeProjectManager()).services);
         // The positive half: the constructor really does install.
         expect(process.listenerCount('unhandledRejection') - before).toBe(1);
         // The negative half: a second instance does not add a second listener.
         new fresh.HydraniumWorkspaceManager(makeStubs(new FakeProjectManager()).services);
         expect(process.listenerCount('unhandledRejection') - before).toBe(1);
      });
   });
});

// ============================================================
// Descriptor documents in the initial build
// ============================================================

describe('HydraniumWorkspaceManager — descriptor documents in the initial build', () => {
   const DESCRIPTOR = URI.parse('file:///workspace/project.test');
   const MEMBER = URI.parse('file:///workspace/member.test');

   /**
    * Project manager that reads its descriptor the way
    * `AbstractProjectManager` does — through
    * `LangiumDocuments.getOrCreateDocument`. That is what puts the descriptor
    * document in the store before Langium's traversal runs, and Langium's
    * traversal then skips URIs that already have a document.
    */
   class DiscoveringProjectManager extends FakeProjectManager {
      constructor(private readonly documents: LangiumDocuments) {
         super();
      }

      override async discoverProjects(folders: readonly WorkspaceFolder[]): Promise<void> {
         await super.discoverProjects(folders);
         await this.documents.getOrCreateDocument(DESCRIPTOR);
      }
   }

   class ExposingWorkspaceManager extends HydraniumWorkspaceManager {
      runPerformStartup(folders: WorkspaceFolder[]): Promise<LangiumDocument[]> {
         return this.performStartup(folders);
      }
   }

   function setup(files: readonly URI[]): { mgr: ExposingWorkspaceManager } {
      const knownDocs = new Map<string, LangiumDocument>();
      const langiumDocuments = {
         getDocument: (uri: URI) => knownDocs.get(uri.toString()),
         hasDocument: (uri: URI) => knownDocs.has(uri.toString()),
         addDocument: (document: LangiumDocument) => knownDocs.set(document.uri.toString(), document),
         getOrCreateDocument: async (uri: URI) => {
            const existing = knownDocs.get(uri.toString());
            if (existing) {
               return existing;
            }
            const created = { uri } as LangiumDocument;
            knownDocs.set(uri.toString(), created);
            return created;
         },
         get all() {
            return Array.from(knownDocs.values());
         }
      } as unknown as LangiumDocuments;
      const services = makeNoopSharedServices({
         ServiceRegistry: makeStubServiceRegistry([{ languageId: 'test', fileExtensions: ['.test'] }]),
         workspace: {
            LangiumDocuments: langiumDocuments,
            DocumentBuilder: { resetToState: () => undefined } as unknown,
            FileSystemProvider: {
               readDirectory: async () => files.map(uri => ({ uri, isFile: true, isDirectory: false }))
            } as unknown,
            WorkspaceLock: { write: <T>(fn: () => Promise<T>) => fn() } as unknown,
            LangiumDocumentFactory: { fromModel: () => undefined, fromString: () => undefined } as unknown,
            ProjectManager: new DiscoveringProjectManager(langiumDocuments)
         }
      });
      return { mgr: new ExposingWorkspaceManager(services) };
   }

   it('returns the descriptor document discovery pre-created, alongside the traversed ones', async () => {
      // Without the back-fill the descriptor is absent from this list, so
      // `initializeWorkspace` never builds it: it stays at `Parsed` with nothing
      // in the global index while `member.test` links against that empty index.
      const { mgr } = setup([DESCRIPTOR, MEMBER]);

      const documents = await mgr.runPerformStartup([{ uri: 'file:///workspace', name: 'workspace' }]);

      expect(documents.map(document => document.uri.toString()).sort()).toEqual([DESCRIPTOR.toString(), MEMBER.toString()].sort());
   });

   it('does not duplicate a descriptor the traversal also returned', async () => {
      // Degenerate-but-real case: an adopter whose descriptors ARE its model
      // files. Every file is pre-created by discovery, so the back-fill supplies
      // all of them and must not double-count.
      const { mgr } = setup([DESCRIPTOR]);

      const documents = await mgr.runPerformStartup([{ uri: 'file:///workspace', name: 'workspace' }]);

      expect(documents.map(document => document.uri.toString())).toEqual([DESCRIPTOR.toString()]);
   });

   it('leaves the traversal result untouched when discovery creates no documents', async () => {
      const { mgr } = setup([MEMBER]);

      const documents = await mgr.runPerformStartup([{ uri: 'file:///workspace', name: 'workspace' }]);

      // The descriptor URI is still created by discovery, so it is present —
      // what this pins is that a member-only traversal is not reordered or lost.
      expect(documents.map(document => document.uri.toString())).toContain(MEMBER.toString());
      expect(documents).toHaveLength(2);
   });
});
