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
   type BindingTarget,
   type DiagramConfiguration,
   DiagramModule,
   DefaultGLSPServer,
   GGraph,
   GLSPServerError,
   type GModelFactory,
   ModelState,
   type ModelSubmissionHandler,
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
import { ReconcilingConflictResolver } from '@hydranium/protocol';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspSubmissionHandler } from '../src/submission/hydranium-glsp-submission-handler.js';
import { HydraniumGlspServer } from '../src/launcher/hydranium-glsp-server.js';
import { makeGlspHarness } from '../src/testing/glsp-harness.js';

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
function normalizedUpstreamBody(): string {
   const prototype = DefaultGLSPServer.prototype as unknown as { handleClientRequest: (...args: never[]) => unknown };
   return prototype.handleClientRequest.toString().replace(/\s+/g, ' ').trim();
}

describe('upstream handleClientRequest', () => {
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
      model: { ModelService: { waitForDocumentState: () => Promise.resolve(), getDocument: () => undefined } }
   } as unknown as ServerSharedServices;
}

function makeFixtureHarness() {
   return makeGlspHarness<TestState>({
      serverModule: new ServerModule().configureDiagramModule(new TestDiagramModule()),
      diagramType: TEST_DIAGRAM_TYPE,
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
