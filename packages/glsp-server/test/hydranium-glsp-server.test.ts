/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
   type ActionMessage,
   type BindingTarget,
   type ClientSession,
   type DiagramConfiguration,
   DiagramModule,
   DefaultGLSPServer,
   GGraph,
   type GLSPServer,
   GLSPServerError,
   type GModelFactory,
   type Logger,
   ModelState,
   type ModelSubmissionHandler,
   NullLogger,
   RejectAction,
   RequestModelAction,
   ServerLayoutKind,
   ServerModule,
   type SourceModelStorage,
   getDefaultMapping
} from '@eclipse-glsp/server';
import { ContainerModule, inject, injectable } from 'inversify';
import type { AstNode } from '@hydranium/langium';
import type { ServerSharedServices } from '@hydranium/core';
import { asModelVersion, ConflictError, ReconcilingConflictResolver, RequestSaveModelAction } from '@hydranium/protocol';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspSubmissionHandler } from '../src/submission/hydranium-glsp-submission-handler.js';
import { HydraniumGlspServer } from '../src/launcher/hydranium-glsp-server.js';
import { DiagramEditDroppedError } from '../src/command/diagram-edit-dropped-error.js';
import { makeGlspHarness } from '../src/testing/glsp-harness.js';
import { waitFor } from '@hydranium/protocol/testing';

/** Reaches the protected projection without a container. */
class ProbeServer extends HydraniumGlspServer {
   detailFor(error: unknown): string | undefined {
      return this.requestFailureDetail(error);
   }
}

describe('HydraniumGlspServer.requestFailureDetail', () => {
   const probe = new ProbeServer();

   it('falls back to the message when a GLSPServerError carries no cause', () => {
      expect(probe.detailFor(new GLSPServerError('no cause here'))).toBe('no cause here');
   });

   it('prefers the cause when a GLSPServerError has one', () => {
      expect(probe.detailFor(new GLSPServerError('the message', 'the cause'))).toBe('the cause');
   });

   // A nullish cause is what upstream's optional chaining treats as absent, so
   // an explicit `undefined` must reach the message rather than the string
   // "undefined" — the shape a caller forwarding an optional produces.
   it('treats a nullish cause as absent', () => {
      expect(probe.detailFor(new GLSPServerError('from message', undefined))).toBe('from message');
      expect(probe.detailFor(new GLSPServerError('from message', null))).toBe('from message');
   });

   it('leaves a plain Error stringified as upstream does', () => {
      expect(probe.detailFor(new Error('plain'))).toBe('Error: plain');
   });

   it('leaves a non-Error rejection stringified and a nullish one undefined', () => {
      expect(probe.detailFor('bare string')).toBe('bare string');
      expect(probe.detailFor(undefined)).toBeUndefined();
      expect(probe.detailFor(null)).toBeUndefined();
   });
});

// ---------------------------------------------------------------------------
// Upstream drift pin. `handleClientRequest` is lifted verbatim apart from the
// detail computation, so a release that rewrites it leaves this package running
// the old body on the path every request takes — silently, since nothing else
// observes the difference. Pinning upstream's own source turns that into a red.
// ---------------------------------------------------------------------------

/** Whitespace-insensitive so a reformat alone does not redden. */
function normalizedUpstreamBody(method: 'handleClientRequest' | 'handleProcessError' | 'process' = 'handleClientRequest'): string {
   const prototype = DefaultGLSPServer.prototype as unknown as Record<typeof method, (...args: never[]) => unknown>;
   return prototype[method].toString().replace(/\s+/g, ' ').trim();
}

describe('DefaultGLSPServer.handleClientRequest', () => {
   it('still matches the body HydraniumGlspServer was lifted from', () => {
      const digest = createHash('sha256').update(normalizedUpstreamBody()).digest('hex');
      expect(
         digest,
         'upstream @eclipse-glsp/server changed DefaultGLSPServer.handleClientRequest — re-lift the body into ' +
            'HydraniumGlspServer (keeping the requestFailureDetail delegation) and update this digest'
      ).toBe('dd0b79da356283341241a06abca8765e9da8993b8e5d606a1f15ede6df394c06');
   });

   // The pin is only worth its brittleness if the projection it guards is
   // actually still upstream's. A release that grew a seam for the detail would
   // make the whole override redundant.
   it('still computes the reject detail from the cause alone', () => {
      expect(normalizedUpstreamBody()).toContain('error instanceof glsp_server_error_1.GLSPServerError');
   });
});

describe('upstream handleProcessError', () => {
   it('still matches the body HydraniumGlspServer was lifted from', () => {
      const digest = createHash('sha256').update(normalizedUpstreamBody('handleProcessError')).digest('hex');
      expect(
         digest,
         'upstream @eclipse-glsp/server changed DefaultGLSPServer.handleProcessError — re-lift the body into ' +
            'HydraniumGlspServer (keeping the single log line) and update this digest'
      ).toBe('dc3aec007c202c28d72bf37ee3cafe83d5d084b7a6022ea41dfc00b82cabb16c');
   });
});

describe('upstream process', () => {
   it('still matches the body HydraniumGlspServer was lifted from', () => {
      const digest = createHash('sha256').update(normalizedUpstreamBody('process')).digest('hex');
      expect(
         digest,
         'upstream @eclipse-glsp/server changed DefaultGLSPServer.process — re-lift the body into ' +
            'HydraniumGlspServer (keeping the debug line and the ended-session check) and update this digest'
      ).toBe('9a24decccecaaa98830a39b7089dfd7c669ae693981d29ad0cd415d8beb15769');
   });
});

// ---------------------------------------------------------------------------
// End-to-end fixture: a real server, a real request, a real reject. Grammar-free
// — the request fails in storage, so nothing downstream of it is reached.
// ---------------------------------------------------------------------------

const TEST_DIAGRAM_TYPE = 'test-diagram';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
}

/** Thrown by {@link ThrowingStorage}; set per test before dispatching. */
let loadFailure: unknown;

@injectable()
class TestState extends AbstractHydraniumGlspState<TestRoot> {
   async updateSourceModel(): Promise<void> {
      /* no-op: the request never gets this far */
   }
}

@injectable()
class ThrowingStorage implements SourceModelStorage {
   loadSourceModel(): void {
      throw loadFailure;
   }
   saveSourceModel(): void {
      /* no-op */
   }
}

@injectable()
class TestGModelFactory implements GModelFactory {
   @inject(ModelState) protected readonly modelState!: TestState;

   createModel(): void {
      this.modelState.updateRoot(GGraph.builder().id('test').build());
   }
}

/** Opt out of the document-readiness gate — the fixture has no Langium document. */
@injectable()
class TestSubmissionHandler extends HydraniumGlspSubmissionHandler<TestRoot> {
   protected override readyEvent = undefined;
}

@injectable()
class TestDiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout = false;
   readonly animatedUpdate = false;
   readonly typeMapping = getDefaultMapping();
   readonly shapeTypeHints = [];
   readonly edgeTypeHints = [];
}

class TestDiagramModule extends DiagramModule {
   readonly diagramType = TEST_DIAGRAM_TYPE;

   protected override bindModelState(): BindingTarget<ModelState> {
      return { service: TestState };
   }
   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return ThrowingStorage;
   }
   protected override bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
      return TestDiagramConfiguration;
   }
   protected override bindGModelFactory(): BindingTarget<GModelFactory> {
      return TestGModelFactory;
   }
   protected override bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler> {
      return TestSubmissionHandler;
   }
}

function stubSharedServices(): ServerSharedServices {
   const childLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      async time<T>(_label: string, fn: () => T | Promise<T>): Promise<T> {
         return fn();
      }
   };
   return {
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: { LangiumDocuments: { getDocument: () => undefined } },
      model: { ModelService: { ensureDocumentState: () => Promise.resolve(), snapshot: () => undefined, getDocument: () => undefined } }
   } as unknown as ServerSharedServices;
}

function makeFixtureHarness(serverModule = new ServerModule(), createLogger?: (caller?: string) => Logger) {
   return makeGlspHarness<TestState>({
      serverModule: serverModule.configureDiagramModule(new TestDiagramModule()),
      diagramType: TEST_DIAGRAM_TYPE,
      createLogger,
      appModules: [
         new ContainerModule(bind => {
            bind(HydraniumTypes.SharedCoreServices).toConstantValue(stubSharedServices());
            bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
         })
      ]
   });
}

/** Drive a request that fails with `error`, and answer with the reject the client receives. */
async function rejectDetailFor(error: unknown): Promise<string | undefined> {
   loadFailure = error;
   const harness = makeFixtureHarness();
   try {
      await harness.start();
      harness.dispatch(RequestModelAction.create());
      const reject = await harness.nextAction<RejectAction>(RejectAction.KIND);
      return reject.detail;
   } finally {
      harness.dispose();
   }
}

describe('a failed GLSP request', () => {
   // The whole point, through a real server: upstream projects a
   // GLSPServerError's cause into the reject, so a throw without one reaches
   // the client with no text at all.
   it('reaches the client with the message of a cause-less GLSPServerError', async () => {
      await expect(rejectDetailFor(new GLSPServerError('storage said no'))).resolves.toBe('storage said no');
   });

   it('still prefers an explicit cause', async () => {
      await expect(rejectDetailFor(new GLSPServerError('outer', 'inner detail'))).resolves.toBe('inner detail');
   });

   it('leaves a plain Error unchanged', async () => {
      await expect(rejectDetailFor(new Error('plain failure'))).resolves.toBe('Error: plain failure');
   });
});

// ---------------------------------------------------------------------------
// A client connection closed before a failed request is answered. Upstream's
// `process` does not await `handleClientRequest`, so a throw from it is an
// unhandled rejection, which ends a Node server started with the default
// `--unhandled-rejections=throw`.
// ---------------------------------------------------------------------------

/** A server whose client connection has closed: every send to the client throws. */
class ClosedConnectionServer extends HydraniumGlspServer {
   constructor() {
      super();
      this.logger = new NullLogger();
      this.glspClientProxy = {
         process: (_message: ActionMessage): void => {
            throw new Error('Connection is closed.');
         }
      };
   }

   protected override sendResponseToClient(): void {
      throw new Error('Connection is closed.');
   }

   /** Sends a request of `kind` whose handler rejects, from a session still open. */
   failRequest(kind: string): Promise<void> {
      const clientSession = {
         id: 'client_1',
         actionDispatcher: { request: () => Promise.reject(new Error('The diagram has closed')) }
      } as unknown as ClientSession;
      this.clientSessions.set('client_1', clientSession);
      return this.handleClientRequest(clientSession, { kind, requestId: 'request_1' }, 'client_1');
   }
}

describe('a failed request on a closed client connection', () => {
   it('settles without throwing for any request', async () => {
      await expect(new ClosedConnectionServer().failRequest('someRequest')).resolves.toBeUndefined();
   });

   it('settles without throwing for a save request, whose error notification also fails to send', async () => {
      await expect(new ClosedConnectionServer().failRequest(RequestSaveModelAction.KIND)).resolves.toBeUndefined();
   });
});

// ---------------------------------------------------------------------------
// One failure reaches the log once: GLSP's own handling logs a failed action
// twice, and a failed save request three times.
// ---------------------------------------------------------------------------

/** A server whose log and client are recorded. */
class RecordingServer extends HydraniumGlspServer {
   readonly errors: string[] = [];
   readonly warnings: string[] = [];
   readonly infos: string[] = [];
   readonly debugs: string[] = [];
   readonly sent: ActionMessage[] = [];

   constructor() {
      super();
      this.initializeResult = { protocolVersion: '1.0.0', serverActions: {} };
      const logger = new NullLogger();
      logger.info = (message: string): void => void this.infos.push(message);
      logger.debug = (message: string): void => void this.debugs.push(message);
      logger.error = (message: string, ...params: unknown[]): void => {
         this.errors.push([message, ...params.map(String)].join(' '));
      };
      logger.warn = (message: string, ...params: unknown[]): void => {
         this.warnings.push([message, ...params.map(String)].join(' '));
      };
      this.logger = logger;
      this.glspClientProxy = { process: (message: ActionMessage): void => void this.sent.push(message) };
   }

   protected override sendResponseToClient(): void {
      /* the reject is not under test */
   }

   failAction(reason: unknown): void {
      void this.handleProcessError({ clientId: 'client_1', action: { kind: 'someAction' } }, reason);
   }

   failRequest(kind: string, reason: unknown): Promise<void> {
      const clientSession = this.open({ request: () => Promise.reject(reason) });
      return this.handleClientRequest(clientSession, { kind, requestId: 'request_1' }, 'client_1');
   }

   /** Open the session `client_1` over `dispatcher`, as `initializeClientSession` does. */
   open(dispatcher: object): ClientSession {
      const clientSession = { id: 'client_1', actionDispatcher: dispatcher } as unknown as ClientSession;
      this.clientSessions.set('client_1', clientSession);
      return clientSession;
   }

   /** End `client_1`, as a dispose or a reopen does before the dispatcher rejects what it held. */
   end(): void {
      this.clientSessions.delete('client_1');
   }
}

describe('HydraniumGlspServer logging the failures it ends', () => {
   it('logs a failed action once, with its stack, and still notifies the client', () => {
      const server = new RecordingServer();
      server.failAction(new Error('boom'));
      expect(server.errors).toHaveLength(1);
      expect(server.errors[0]).toMatch(/someAction[\s\S]*boom[\s\S]*\n\s+at /);
      expect(server.sent.map(message => message.action.kind)).toEqual(['message']);
   });

   it('warns once for a conflict, which is declined rather than failed, naming both versions', () => {
      const server = new RecordingServer();
      server.failAction(new ConflictError('file:///a.x', asModelVersion(1), 2));
      expect(server.errors).toEqual([]);
      expect(server.warnings).toHaveLength(1);
      expect(server.warnings[0]).toContain('model v1 / text v2');
   });

   it('leaves a dropped diagram edit to the warning its reconcile logged, and still notifies the client', () => {
      const server = new RecordingServer();
      server.failAction(new DiagramEditDroppedError('The undo of an operation was dropped'));
      expect({ errors: server.errors, warnings: server.warnings }).toEqual({ errors: [], warnings: [] });
      expect(server.sent.map(message => message.action.kind)).toEqual(['message']);
   });

   it('logs a failed request once', async () => {
      const server = new RecordingServer();
      await server.failRequest('someRequest', new Error('boom'));
      expect(server.errors).toHaveLength(1);
   });

   it('logs a failed save request once, and still notifies, when its reject cannot be sent', async () => {
      class RejectFailingServer extends RecordingServer {
         protected override sendResponseToClient(): void {
            throw new Error('reject refused');
         }
      }
      const server = new RejectFailingServer();
      await server.failRequest(RequestSaveModelAction.KIND, new Error('disk full'));
      expect(server.errors.filter(line => line.includes('disk full'))).toHaveLength(1);
      expect(server.sent.map(message => message.action.kind)).toEqual(['message']);
   });

   it('logs a failed save request once, beside the notification it adds', async () => {
      const server = new RecordingServer();
      await server.failRequest(RequestSaveModelAction.KIND, new Error('disk full'));
      expect(server.errors).toHaveLength(1);
      expect(server.sent.map(message => message.action.kind)).toEqual(['message']);
   });

   it('recognises a dropped diagram edit thrown by another installed copy of this package, by its name', () => {
      const server = new RecordingServer();
      const fromOtherCopy = Object.assign(new Error('The undo of an operation was dropped'), { name: 'DiagramEditDroppedError' });
      server.failAction(fromOtherCopy);
      expect({ errors: server.errors, warnings: server.warnings }).toEqual({ errors: [], warnings: [] });
   });

   it('names the request id in the one line about a failed save request, as for any failed request', async () => {
      const server = new RecordingServer();
      await server.failRequest(RequestSaveModelAction.KIND, new Error('disk full'));
      expect(server.errors).toHaveLength(1);
      expect(server.errors[0]).toContain(`'${RequestSaveModelAction.KIND}' (request_1)`);
   });

   it('logs each action it processes at debug, since that is diagnosis', () => {
      const server = new RecordingServer();
      server.open({ dispatch: () => Promise.resolve() });
      server.process({ clientId: 'client_1', action: { kind: 'someAction' } });
      expect(server.infos).toEqual([]);
      expect(server.debugs.some(line => line.includes('someAction'))).toBe(true);
   });

   it('logs a request its ended session rejected at debug', async () => {
      const server = new RecordingServer();
      const clientSession = server.open({
         request: () => {
            server.end();
            return Promise.reject(new Error("Request 'request_1' cancelled: dispatcher disposed"));
         }
      });
      await server['handleClientRequest'](clientSession, { kind: 'someRequest', requestId: 'request_1' }, 'client_1');
      expect(server.errors).toEqual([]);
      expect(server.debugs.some(line => line.includes('dispatcher disposed'))).toBe(true);
   });

   it('logs an action its ended session rejected at debug, and tells no client', async () => {
      const server = new RecordingServer();
      server.open({
         dispatch: () => {
            server.end();
            return Promise.reject(new Error('ActionDispatcher disposed'));
         }
      });
      server.process({ clientId: 'client_1', action: { kind: 'someAction' } });
      await waitFor(() => server.debugs.some(line => line.includes('ActionDispatcher disposed')));
      expect({ errors: server.errors, sent: server.sent }).toEqual({ errors: [], sent: [] });
   });

   it('logs an action rejected after its session was opened again at debug, and tells the new one nothing', async () => {
      const server = new RecordingServer();
      server.open({
         dispatch: () => {
            server.open({});
            return Promise.reject(new Error('ActionDispatcher disposed'));
         }
      });
      server.process({ clientId: 'client_1', action: { kind: 'someAction' } });
      await waitFor(() => server.debugs.some(line => line.includes('ActionDispatcher disposed')));
      expect({ errors: server.errors, sent: server.sent }).toEqual({ errors: [], sent: [] });
   });
});

// ---------------------------------------------------------------------------
// Which server the server container resolves. The framework's replaces
// upstream's, and an adopter extending it keeps their own.
// ---------------------------------------------------------------------------

@injectable()
class AdopterServer extends HydraniumGlspServer {}

class AdopterServerModule extends ServerModule {
   protected override bindGLSPServer(): BindingTarget<GLSPServer> {
      return AdopterServer;
   }
}

@injectable()
class UpstreamAdopterServer extends DefaultGLSPServer {}

class UpstreamAdopterServerModule extends ServerModule {
   protected override bindGLSPServer(): BindingTarget<GLSPServer> {
      return UpstreamAdopterServer;
   }
}

/** The server the container resolves, and the warnings logged while resolving it. */
function serverBoundBy(serverModule: ServerModule): { server: unknown; warnings: string[] } {
   const warnings: string[] = [];
   const logger = new NullLogger();
   logger.warn = (message: string): void => {
      warnings.push(message);
   };
   const harness = makeFixtureHarness(serverModule, () => logger);
   try {
      return { server: harness.server, warnings };
   } finally {
      harness.dispose();
   }
}

describe('the GLSP server a server module binds', () => {
   it("is replaced by the framework's, silently, when it is upstream's", () => {
      const { server, warnings } = serverBoundBy(new ServerModule());
      expect(server).toBeInstanceOf(HydraniumGlspServer);
      expect(warnings).toEqual([]);
   });

   it("is kept, silently, when it extends the framework's", () => {
      const { server, warnings } = serverBoundBy(new AdopterServerModule());
      expect(server).toBeInstanceOf(AdopterServer);
      expect(warnings).toEqual([]);
   });

   it("is replaced with a warning naming it and the fix when it extends upstream's", () => {
      const { server, warnings } = serverBoundBy(new UpstreamAdopterServerModule());
      expect(server).toBeInstanceOf(HydraniumGlspServer);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('UpstreamAdopterServer');
      expect(warnings[0]).toContain('extend HydraniumGlspServer');
   });
});
