/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { DocumentState, type LangiumDocument } from '@hydranium/langium';
import { CancellationToken } from 'vscode-languageserver';
import { Disposable, Logger } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import type { ServerSharedServices } from '../../../src/langium/module.js';
import {
   type BuildPhasePassService,
   DefaultBuildPhasePassService
} from '../../../src/langium/build-phase-pass/build-phase-pass-service.js';
import { type CapturedLine, makeCapturingTracer, makeNoopSharedServices } from '../../../src/testing/index.js';

function makeService(buildPhasePasses?: unknown): BuildPhasePassService {
   return new DefaultBuildPhasePassService(makeNoopSharedServices<ServerSharedServices>({ buildPhasePasses }));
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('BuildPhasePassService — dispatch', () => {
   it('runs only passes whose `state` matches the phase', async () => {
      const service = makeService();
      const ran: string[] = [];
      service.register({ id: 'linked', state: DocumentState.Linked, run: () => void ran.push('linked') });
      service.register({ id: 'parsed', state: DocumentState.Parsed, run: () => void ran.push('parsed') });

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);
      expect(ran).toEqual(['linked']);
   });

   it('runs passes in priority order — lower runs first', async () => {
      const service = makeService();
      const ran: string[] = [];
      service.register({ id: 'late', priority: 10, state: DocumentState.Linked, run: () => void ran.push('late') });
      service.register({ id: 'early', priority: -1, state: DocumentState.Linked, run: () => void ran.push('early') });
      service.register({ id: 'mid', priority: 5, state: DocumentState.Linked, run: () => void ran.push('mid') });

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);
      expect(ran).toEqual(['early', 'mid', 'late']);
   });

   it('breaks priority ties by registration order', async () => {
      const service = makeService();
      const ran: string[] = [];
      service.register({ id: 'first', state: DocumentState.Linked, run: () => void ran.push('first') });
      service.register({ id: 'second', state: DocumentState.Linked, run: () => void ran.push('second') });

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);
      expect(ran).toEqual(['first', 'second']);
   });

   it('awaits each async pass before starting the next', async () => {
      const service = makeService();
      const events: string[] = [];
      service.register({
         id: 'async',
         priority: 0,
         state: DocumentState.Linked,
         run: async () => {
            events.push('async:start');
            await tick();
            events.push('async:end');
         }
      });
      service.register({ id: 'sync', priority: 1, state: DocumentState.Linked, run: () => void events.push('sync') });

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);
      expect(events).toEqual(['async:start', 'async:end', 'sync']);
   });

   it('passes the documents and cancel token through to each run', async () => {
      const service = makeService();
      const documents = [{ uri: 'a' } as unknown as LangiumDocument];
      let received: { documents: readonly LangiumDocument[]; token: CancellationToken } | undefined;
      service.register({
         id: 'capture',
         state: DocumentState.Linked,
         run: (docs, token) => void (received = { documents: docs, token })
      });

      await service.runPasses(documents, DocumentState.Linked, CancellationToken.None);
      expect(received?.documents).toBe(documents);
      expect(received?.token).toBe(CancellationToken.None);
   });
});

describe('BuildPhasePassService — cancellation', () => {
   it('runs nothing when the entry token is already cancelled', async () => {
      const service = makeService();
      const ran: string[] = [];
      service.register({ id: 'a', state: DocumentState.Linked, run: () => void ran.push('a') });

      await service.runPasses([], DocumentState.Linked, CancellationToken.Cancelled);
      expect(ran).toEqual([]);
   });

   it('stops before the next pass once the token is cancelled mid-run', async () => {
      const service = makeService();
      const ran: string[] = [];
      let cancelled = false;
      const token = {
         get isCancellationRequested() {
            return cancelled;
         },
         onCancellationRequested: () => Disposable.EMPTY
      } as CancellationToken;

      service.register({
         id: 'a',
         priority: 0,
         state: DocumentState.Linked,
         run: () => {
            ran.push('a');
            cancelled = true;
         }
      });
      service.register({ id: 'b', priority: 1, state: DocumentState.Linked, run: () => void ran.push('b') });

      await service.runPasses([], DocumentState.Linked, token);
      expect(ran).toEqual(['a']);
   });
});

describe('BuildPhasePassService — registration', () => {
   it('throws on duplicate id', () => {
      const service = makeService();
      service.register({ id: 'dup', state: DocumentState.Linked, run: () => undefined });
      expect(() => service.register({ id: 'dup', state: DocumentState.Linked, run: () => undefined })).toThrow(
         /Duplicate registry id: 'dup'/
      );
   });

   it('disposal removes the pass so subsequent runs skip it', async () => {
      const service = makeService();
      const ran: string[] = [];
      const handle = service.register({ id: 'x', state: DocumentState.Linked, run: () => void ran.push('x') });

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);
      handle.dispose();
      await service.runPasses([], DocumentState.Linked, CancellationToken.None);

      expect(ran).toEqual(['x']);
   });

   it('reads `services.buildPhasePasses` and registers each contribution at construction', async () => {
      const ran: string[] = [];
      const service = makeService({
         alpha: {
            registerBuildPhasePasses: (registry: BuildPhasePassService) => {
               registry.register({ id: 'alpha-pass', priority: 0, state: DocumentState.Linked, run: () => void ran.push('alpha') });
            }
         },
         beta: {
            registerBuildPhasePasses: (registry: BuildPhasePassService) => {
               registry.register({ id: 'beta-pass', priority: 1, state: DocumentState.Linked, run: () => void ran.push('beta') });
            }
         }
      });

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);
      expect(ran).toEqual(['alpha', 'beta']);
   });
});

describe('BuildPhasePassService — profiling', () => {
   afterEach(() => Logger.setLevel('info'));

   function capturingService(): { service: BuildPhasePassService; lines: CapturedLine[] } {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const services = makeNoopSharedServices<ServerSharedServices>({ Tracer: tracer });
      return { service: new DefaultBuildPhasePassService(services), lines };
   }

   it('profiles per-pass self-time and reports it line-based at debug level', async () => {
      const { service, lines } = capturingService();
      service.register({ id: 'passA', state: DocumentState.Linked, run: () => undefined });
      service.register({ id: 'passB', state: DocumentState.Linked, run: () => undefined });
      Logger.setLevel('debug');

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);

      const profileLines = lines.map(line => line.message).filter(message => message.includes('[profile build-phase-pass'));
      expect(profileLines.some(message => message.includes('passA'))).toBe(true);
      expect(profileLines.some(message => message.includes('passB'))).toBe(true);
   });

   it('allocates no session at the default info level', async () => {
      const { service, lines } = capturingService();
      service.register({ id: 'passA', state: DocumentState.Linked, run: () => undefined });

      await service.runPasses([], DocumentState.Linked, CancellationToken.None);
      expect(lines.map(line => line.message).filter(message => message.includes('[profile'))).toHaveLength(0);
   });
});
