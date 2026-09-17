/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import type {
   RpcProxy,
   FindNextNameArgs,
   ReferenceCandidate,
   ReferenceContext,
   ReferenceRequest,
   ReferenceServerProtocol,
   ReferenceTarget,
   TransferElement
} from '@hydranium/protocol';
import { Emitter } from '@theia/core';
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
      protected readonly fake: RecordingServer,
      private readonly log: string[]
   ) {
      super();
   }

   // The connection is not the subject here: this suite asserts that each
   // delegate gates before forwarding. Overriding the getter keeps the real
   // lifecycle out of a test that would only stub it.
   protected override get server(): RpcProxy<RecordingServer> {
      return asProxy(this.fake);
   }

   /** Stand in for a settled readiness gate, logging that it was awaited. */
   protected override ensureConnected(): Promise<void> {
      this.log.push('gate');
      return Promise.resolve();
   }
}

const CONTEXT: ReferenceContext = { source: { uri: 'file:///a.x' }, property: 'ref' };

/** A recording server presented as the proxy shape the base exposes. */
function asProxy(server: RecordingServer): RpcProxy<RecordingServer> {
   const never = new Emitter<void>().event;
   return Object.assign(server, { onDidOpenConnection: never, onDidCloseConnection: never });
}

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
