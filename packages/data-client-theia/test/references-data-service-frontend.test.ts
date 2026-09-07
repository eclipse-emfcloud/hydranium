/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { Deferred } from '@theia/core/lib/common/promise-util';
import type {
   FindNextNameArgs,
   ReferenceCandidate,
   ReferenceContext,
   ReferenceRequest,
   ReferenceServerProtocol,
   ReferenceTarget,
   TransferElement
} from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { AbstractReferencesDataServiceFrontend } from '../src/browser/references-data-service-frontend';

/**
 * Appends into a log shared with the frontend's gate, so the test can assert
 * the gate runs BEFORE each delegate rather than merely that it ran at all.
 */
class RecordingServer implements ReferenceServerProtocol<TransferElement> {
   constructor(readonly log: string[]) {}

   async waitForReady(): Promise<void> {
      /* already ready in these tests */
   }

   async findReferenceCandidates(ctx: ReferenceContext): Promise<ReferenceCandidate[]> {
      this.log.push(`findReferenceCandidates:${ctx.property}`);
      return [];
   }

   async resolveReference(ref: ReferenceRequest): Promise<ReferenceTarget<TransferElement> | undefined> {
      this.log.push(`resolveReference:${ref.value}`);
      return undefined;
   }

   async findNextName(args: FindNextNameArgs): Promise<string> {
      this.log.push(`findNextName:${args.proposal}`);
      return 'Proposal1';
   }
}

/** Minimal concrete subclass exposing the gate + injecting the recording server. */
class TestFrontend extends AbstractReferencesDataServiceFrontend<TransferElement, RecordingServer, object> {
   protected readonly connectionProvider = undefined as never;
   protected readonly workspaceService = undefined;
   protected readonly client = {};
   protected readonly servicePath = '/test';
   protected readonly methodNamespace = 'test';
   protected readonly clientMethods = [];

   constructor(
      server: RecordingServer,
      private readonly log: string[]
   ) {
      super();
      this.server = server;
   }

   /** Stand in for a live, already-initialized connection and log the gate. */
   protected override ensureConnected(): Promise<void> {
      this.log.push('gate');
      if (!this.initialized) {
         this.initialized = new Deferred<void>();
         this.initialized.resolve();
      }
      return this.initialized.promise;
   }
}

const CONTEXT: ReferenceContext = { source: { uri: 'file:///a.x' }, property: 'ref' };

describe('AbstractReferencesDataServiceFrontend', () => {
   it('gates on readiness before delegating each reference method to the server', async () => {
      const log: string[] = [];
      const frontend = new TestFrontend(new RecordingServer(log), log);

      expect(await frontend.findReferenceCandidates(CONTEXT)).toEqual([]);
      expect(await frontend.resolveReference({ ...CONTEXT, value: 'target' })).toBeUndefined();
      expect(await frontend.findNextName({ uri: 'file:///a.x', type: 'TypeOne', proposal: 'Proposal' })).toBe('Proposal1');

      // Interleaved, not grouped: proves the gate precedes every delegate
      // rather than having been awaited once somewhere before the calls.
      expect(log).toEqual(['gate', 'findReferenceCandidates:ref', 'gate', 'resolveReference:target', 'gate', 'findNextName:Proposal']);
   });
});
