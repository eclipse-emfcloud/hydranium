/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import type { DataServerDiagnosticsProtocol, LatencyReport, RpcProxy } from '@hydranium/protocol';
import { Emitter } from '@theia/core';
import { describe, expect, it } from 'vitest';
import { AbstractDiagnosticsDataServiceFrontend } from '../src/browser/diagnostics-data-service-frontend';

/** Records every delegated call and returns a marker so we can assert the pass-through. */
class RecordingServer implements DataServerDiagnosticsProtocol {
   readonly calls: Array<[string, unknown]> = [];
   async waitForReady(): Promise<void> {
      /* already ready in these tests */
   }
   async dumpServerState(args: unknown): Promise<string> {
      this.calls.push(['dumpServerState', args]);
      return 'state';
   }
   async writeHeapSnapshot(args: unknown): Promise<string> {
      this.calls.push(['writeHeapSnapshot', args]);
      return '/tmp/heap';
   }
   async dumpPodMemory(): Promise<string> {
      this.calls.push(['dumpPodMemory', undefined]);
      return 'pod';
   }
   async startProfiling(args: unknown): Promise<void> {
      this.calls.push(['startProfiling', args]);
   }
   async stopProfiling(args: unknown): Promise<string> {
      this.calls.push(['stopProfiling', args]);
      return '/tmp/profile';
   }
   async getLatency(): Promise<LatencyReport> {
      this.calls.push(['getLatency', undefined]);
      return {} as LatencyReport;
   }
}

/** Minimal concrete subclass exposing the gate + injecting the recording server. */
class TestFrontend extends AbstractDiagnosticsDataServiceFrontend<RecordingServer, object> {
   protected readonly connectionProvider = undefined as never;
   protected readonly workspaceService = undefined;
   protected readonly client = {};
   protected readonly servicePath = '/test';
   protected readonly methodNamespace = 'test';
   protected readonly clientMethods = [];
   gateAwaited = false;

   constructor(protected readonly fake: RecordingServer) {
      super();
   }

   // The connection is not the subject here: these suites assert that each
   // delegate gates before forwarding. Overriding the getter keeps the real
   // lifecycle out of a test that would only stub it.
   protected override get server(): RpcProxy<RecordingServer> {
      return asProxy(this.fake);
   }

   /** Stand in for a settled readiness gate, recording that it was awaited. */
   protected override ensureConnected(): Promise<void> {
      this.gateAwaited = true;
      return Promise.resolve();
   }
}

/** A recording server presented as the proxy shape the base exposes. */
function asProxy(server: RecordingServer): RpcProxy<RecordingServer> {
   const never = new Emitter<void>().event;
   return Object.assign(server, { onDidOpenConnection: never, onDidCloseConnection: never });
}

describe('AbstractDiagnosticsDataServiceFrontend', () => {
   it('delegates every diagnostics method to the server after gating on readiness', async () => {
      const server = new RecordingServer();
      const frontend = new TestFrontend(server);

      expect(await frontend.dumpServerState({ label: 'l' })).toBe('state');
      expect(await frontend.writeHeapSnapshot({ directory: 'd' })).toBe('/tmp/heap');
      expect(await frontend.dumpPodMemory()).toBe('pod');
      await frontend.startProfiling({ cpu: true });
      expect(await frontend.stopProfiling({ directory: 'd' })).toBe('/tmp/profile');
      await frontend.getLatency();

      expect(frontend.gateAwaited).toBe(true);
      expect(server.calls.map(([method]) => method)).toEqual([
         'dumpServerState',
         'writeHeapSnapshot',
         'dumpPodMemory',
         'startProfiling',
         'stopProfiling',
         'getLatency'
      ]);
      expect(server.calls[0][1]).toEqual({ label: 'l' });
   });
});
